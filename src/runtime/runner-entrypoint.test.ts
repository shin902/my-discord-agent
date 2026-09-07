import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const entrypoint = join(process.cwd(), "scripts/runner-entrypoint.sh");
const temporaryDirectories: string[] = [];

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function setup(gateway = "172.17.0.1"): Promise<{
  directory: string;
  iptablesCapture: string;
  ip6tablesCapture: string;
  setprivCapture: string;
  path: string;
}> {
  const directory = await mkdtemp(join("/tmp", "runner-entrypoint-"));
  temporaryDirectories.push(directory);
  const bin = join(directory, "bin");
  const iptablesCapture = join(directory, "iptables.args");
  const ip6tablesCapture = join(directory, "ip6tables.args");
  const setprivCapture = join(directory, "setpriv.args");
  await mkdir(bin);

  for (const command of ["iptables", "ip6tables"]) {
    const capture = command === "iptables" ? iptablesCapture : ip6tablesCapture;
    await writeExecutable(
      join(bin, command),
      `#!/bin/sh\nprintf '%s\\n' "${command} $*" >> "${capture}"\n`,
    );
  }
  await writeExecutable(
    join(bin, "awk"),
    gateway ? `#!/bin/sh\nprintf '%s\\n' ${gateway}\n` : "#!/bin/sh\nexit 0\n",
  );
  await writeExecutable(
    join(bin, "setpriv"),
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$RUNNER_ENTRYPOINT_SETPRIV_CAPTURE"\n',
  );

  return {
    directory,
    iptablesCapture,
    ip6tablesCapture,
    setprivCapture,
    path: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Agent Runner network entrypoint", () => {
  it("installs default-deny IPv4/IPv6 rules and drops setup authority", async () => {
    const fixture = await setup();

    await execFileAsync("sh", [entrypoint, "node", "/app/runner.mjs"], {
      env: {
        ...process.env,
        PATH: fixture.path,
        RUNNER_UID: "1000",
        RUNNER_GID: "1000",
        RUNNER_ALLOWED_HOST_PORTS: "8317,23456",
        RUNNER_ENTRYPOINT_SETPRIV_CAPTURE: fixture.setprivCapture,
      },
    });

    const [ipv4, ipv6, setpriv] = await Promise.all([
      readFile(fixture.iptablesCapture, "utf8"),
      readFile(fixture.ip6tablesCapture, "utf8"),
      readFile(fixture.setprivCapture, "utf8"),
    ]);

    expect(ipv4).toContain("iptables -F OUTPUT");
    expect(ipv4).toContain("iptables -P OUTPUT DROP");
    expect(ipv4).toContain(
      "iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT",
    );
    expect(ipv4).toContain(
      "iptables -A OUTPUT -d 172.17.0.1 -p tcp --dport 8317 -m conntrack --ctstate NEW -j ACCEPT",
    );
    expect(ipv4).toContain(
      "iptables -A OUTPUT -d 172.17.0.1 -p tcp --dport 23456 -m conntrack --ctstate NEW -j ACCEPT",
    );
    expect(ipv4).not.toMatch(/127\.0\.0\.1|10\.0\.0\.0|169\.254/);

    expect(ipv6).toContain("ip6tables -F OUTPUT");
    expect(ipv6).toContain("ip6tables -P OUTPUT DROP");
    expect(ipv6).not.toContain("--dport");

    expect(setpriv).toContain("--reuid\n1000");
    expect(setpriv).toContain("--regid\n1000");
    expect(setpriv).toContain("--bounding-set=-all");
    expect(setpriv).toContain("--inh-caps=-all");
    expect(setpriv).toContain("--ambient-caps=-all");
    expect(setpriv).toContain("--\nnode\n/app/runner.mjs");
  });

  it("fails closed when the host gateway or runner identity is missing", async () => {
    const fixture = await setup("");

    await expect(
      execFileAsync("sh", [entrypoint, "node", "/app/runner.mjs"], {
        env: {
          ...process.env,
          PATH: fixture.path,
          RUNNER_UID: "1000",
          RUNNER_GID: "1000",
          RUNNER_ENTRYPOINT_SETPRIV_CAPTURE: fixture.setprivCapture,
          RUNNER_ALLOWED_HOST_PORTS: "8317",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "host.docker.internal is not present in /etc/hosts",
      ),
    });
  });
});
