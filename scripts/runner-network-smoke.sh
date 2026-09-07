#!/usr/bin/env bash
set -euo pipefail

image="${RUNNER_IMAGE:-my-discord-agent-runner:network-smoke}"
run_id="runner-network-$RANDOM-$$"
tmp_dir="$(mktemp -d)"
host_server_pid=""
containers=()
networks=()

cleanup() {
  if [[ -n "$host_server_pid" ]]; then kill "$host_server_pid" 2>/dev/null || true; fi
  if ((${#containers[@]})); then docker rm -f "${containers[@]}" >/dev/null 2>&1 || true; fi
  if ((${#networks[@]})); then docker network rm "${networks[@]}" >/dev/null 2>&1 || true; fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

pnpm build:runner
docker build -t "$image" .

node - "$tmp_dir/ports" <<'NODE' &
const fs = require("node:fs");
const http = require("node:http");
const output = process.argv[2];
const servers = ["credential", "tool", "forbidden"].map((name) =>
  http.createServer((request, response) => {
    if (name === "tool" && (request.url !== "/__tool-proxy/rpc" || request.headers.authorization !== "Bearer smoke-token")) {
      response.writeHead(403).end("forbidden");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" }).end(name);
  }),
);
Promise.all(servers.map((server) => new Promise((resolve) => server.listen(0, "0.0.0.0", resolve))))
  .then(() => {
    fs.writeFileSync(output, `${servers.map((server) => server.address().port).join(",")}\n`);
  });
NODE
host_server_pid=$!
for _ in {1..100}; do [[ -s "$tmp_dir/ports" ]] && break; sleep 0.05; done
[[ -s "$tmp_dir/ports" ]] || { echo "host canaries did not start" >&2; exit 1; }
IFS=, read -r credential_port tool_port forbidden_port < "$tmp_dir/ports"

public_network="${run_id}-public"
private_network="${run_id}-private"
metadata_network="${run_id}-metadata"
networks+=("$public_network" "$private_network" "$metadata_network")
docker network create --subnet 203.0.113.0/24 "$public_network" >/dev/null
docker network create --subnet 10.251.0.0/24 "$private_network" >/dev/null
docker network create --subnet 169.254.0.0/16 "$metadata_network" >/dev/null

canary="${run_id}-canary"
containers+=("$canary")
docker run -d --name "$canary" --network "$public_network" --ip 203.0.113.10 \
  --entrypoint node "$image" -e '
    const http = require("node:http");
    http.createServer((_request, response) => response.end("network-canary")).listen(8080, "0.0.0.0");
    http.createServer((_request, response) => response.end("metadata-canary")).listen(80, "0.0.0.0");
  ' >/dev/null
docker network connect --ip 10.251.0.10 "$private_network" "$canary"
docker network connect --ip 169.254.169.254 "$metadata_network" "$canary"

probe_script='const http = require("node:http");
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { ...options, timeout: 1500 }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}
async function mustReach(url, expected, options) {
  const result = await request(url, options);
  if (result.status !== 200 || result.body !== expected) throw new Error(`expected ${url} to be reachable: ${JSON.stringify(result)}`);
}
async function mustDeny(url) {
  try { await request(url); } catch { return; }
  throw new Error(`expected ${url} to be denied`);
}
(async () => {
  const local = http.createServer((_request, response) => response.end("localhost"));
  await new Promise((resolve) => local.listen(18080, "127.0.0.1", resolve));
  if (process.env.EXPECT_RESTRICTED === "1") {
    const status = require("node:fs").readFileSync("/proc/self/status", "utf8");
    const capabilityFields = ["CapEff", "CapPrm", "CapBnd", "CapInh", "CapAmb"];
    if (process.getuid() === 0 || capabilityFields.some((field) => !new RegExp(`^${field}:\\s+0+$`, "m").test(status)) || !/^NoNewPrivs:\s+1$/m.test(status)) {
      throw new Error("runner retained root, capabilities, or privilege escalation ability");
    }
    await mustReach(`http://host.docker.internal:${process.env.CREDENTIAL_PORT}/`, "credential");
    await mustReach(`http://host.docker.internal:${process.env.TOOL_PORT}/__tool-proxy/rpc`, "tool", { method: "POST", headers: { authorization: "Bearer smoke-token" } });
    await mustDeny(`http://host.docker.internal:${process.env.FORBIDDEN_PORT}/`);
    await mustDeny("http://203.0.113.10:8080/");
    await mustDeny("http://10.251.0.10:8080/");
    await mustDeny("http://169.254.169.254:8080/");
    await mustDeny("http://169.254.169.254/latest/meta-data/");
    await mustDeny("http://127.0.0.1:18080/");
  } else {
    await mustReach(`http://host.docker.internal:${process.env.FORBIDDEN_PORT}/`, "forbidden");
    await mustReach("http://203.0.113.10:8080/", "network-canary");
    await mustReach("http://10.251.0.10:8080/", "network-canary");
    await mustReach("http://169.254.169.254:8080/", "network-canary");
    await mustReach("http://169.254.169.254/latest/meta-data/", "metadata-canary");
    await mustReach("http://127.0.0.1:18080/", "localhost");
  }
  local.close();
  console.log(process.env.EXPECT_RESTRICTED === "1" ? "__RUNNER_NETWORK_BOUNDARY_OK__" : "__RUNNER_NETWORK_CONTROL_OK__");
})().catch((error) => { console.error(error); process.exit(1); });'

create_probe() {
  local name="$1"
  shift
  containers+=("$name")
  docker create --name "$name" --add-host=host.docker.internal:host-gateway \
    -e "CREDENTIAL_PORT=$credential_port" \
    -e "TOOL_PORT=$tool_port" \
    -e "FORBIDDEN_PORT=$forbidden_port" \
    "$@" "$image" node -e "$probe_script" >/dev/null
  docker network connect "$public_network" "$name"
  docker network connect "$private_network" "$name"
  docker network connect "$metadata_network" "$name"
}

control="${run_id}-control"
create_probe "$control" --entrypoint=""
control_output="$(docker start -a "$control")"
grep -qx '__RUNNER_NETWORK_CONTROL_OK__' <<<"$control_output"

restricted="${run_id}-restricted"
create_probe "$restricted" \
  --cap-drop=ALL \
  --cap-add=NET_ADMIN \
  --cap-add=SETUID \
  --cap-add=SETGID \
  --cap-add=SETPCAP \
  --security-opt=no-new-privileges=true \
  -e "RUNNER_UID=$(id -u)" \
  -e "RUNNER_GID=$(id -g)" \
  -e "RUNNER_ALLOWED_HOST_PORTS=$credential_port,$tool_port" \
  -e EXPECT_RESTRICTED=1
restricted_output="$(docker start -a "$restricted")"
printf '%s\n' "$restricted_output"
grep -qx '__RUNNER_NETWORK_BOUNDARY_OK__' <<<"$restricted_output"
