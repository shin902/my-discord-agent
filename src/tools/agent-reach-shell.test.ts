import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import networkCases from "./__fixtures__/agent-reach/network-cases.json" with {
  type: "json",
};
import parityCases from "./__fixtures__/agent-reach/parity-cases.json" with {
  type: "json",
};
import { installRssPythonFixtures } from "./agent-reach-rss-test-utils.js";

const execFileAsync = promisify(execFile);
const agentReachScript = join(
  import.meta.dirname,
  "../../templates/SKILLS/agent-reach/scripts/agent-reach.sh",
);

async function installPublicDig(binDir: string): Promise<void> {
  const dig = join(binDir, "dig");
  await writeFile(
    dig,
    `#!/usr/bin/env bash
set -euo pipefail
record_type=""
for arg in "$@"; do
  case "$arg" in
    A|AAAA) record_type="$arg" ;;
  esac
done
host="\${@: -2:1}"
printf '%s\\n' ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1'
case "$record_type" in
  A) printf '%s\\n' "$host 60 IN A 8.8.8.8" ;;
  AAAA) printf '%s\\n' "$host 60 IN AAAA 2001:4860:4860::8888" ;;
  *) exit 2 ;;
esac
`,
    "utf8",
  );
  await chmod(dig, 0o755);
}

describe("agent-reach.sh YouTube字幕", () => {
  let testDir: string;
  let binDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-reach-shell-test-"));
    binDir = join(testDir, "bin");
    await mkdir(binDir);
    await installPublicDig(binDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("cue timingと同じ行にある字幕本文を保持する", async () => {
    const ytDlp = join(binDir, "yt-dlp");
    await writeFile(
      ytDlp,
      `#!/usr/bin/env bash
set -euo pipefail

if [[ " $* " == *" --dump-json "* ]]; then
  printf '%s\\n' '{"title":"test","chapters":[]}'
  exit 0
fi

while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    output="$2"
    break
  fi
  shift
done

subs_dir="$(dirname "$output")"
cat > "$subs_dir/video.en-orig.vtt" <<'VTT'
WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:01.000 align:start position:0% Hello
VTT
`,
      "utf8",
    );
    await chmod(ytDlp, 0o755);

    const { stdout } = await execFileAsync(
      "bash",
      [agentReachScript, "https://www.youtube.com/watch?v=test"],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(stdout).toContain("## 字幕 (en-orig)");
    expect(stdout).toContain("Hello");
    expect(stdout).not.toContain("-->");
  });

  it("fake yt-dlp に原語セレクターだけを渡し、字幕なしは明示する", async () => {
    const ytDlp = join(binDir, "yt-dlp");
    const argsLog = join(testDir, "yt-dlp-args.log");
    await writeFile(
      ytDlp,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$AGENT_REACH_YTDLP_ARGS"
if [[ " $* " == *" --dump-json "* ]]; then
  printf '%s\\n' '{"title":"fixture","chapters":[]}'
fi
`,
      "utf8",
    );
    await chmod(ytDlp, 0o755);

    const { stdout } = await execFileAsync(
      "bash",
      [agentReachScript, parityCases.youtube.url],
      {
        env: {
          ...process.env,
          AGENT_REACH_YTDLP_ARGS: argsLog,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    const invocations = (await readFile(argsLog, "utf8")).trim().split("\n");
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toContain(
      `--write-auto-subs --sub-langs ${parityCases.youtube.originalSubtitleSelector}`,
    );
    expect(invocations[1]).not.toContain(
      parityCases.youtube.translatedSubtitleSelector,
    );
    expect(stdout).toContain("## 字幕");
    expect(stdout).toContain("(取得できませんでした)");
  });

  it("字幕取得のstderrと終了失敗をエージェントへ伝える", async () => {
    const ytDlp = join(binDir, "yt-dlp");
    await writeFile(
      ytDlp,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --dump-json "* ]]; then
  printf '%s\\n' '{"title":"fixture","chapters":[]}'
  exit 0
fi
printf '%s\\n' '${parityCases.youtube.retrievalError}' >&2
exit 1
`,
      "utf8",
    );
    await chmod(ytDlp, 0o755);

    await expect(
      execFileAsync("bash", [agentReachScript, parityCases.youtube.url], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(parityCases.youtube.retrievalError),
    });
  });
});

describe("agent-reach.sh URL 正規化", () => {
  let testDir: string;
  let binDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-reach-shell-test-"));
    binDir = join(testDir, "bin");
    await mkdir(binDir);
    await installPublicDig(binDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("意味のある query を保持し fragment だけを除去する", async () => {
    const curl = join(binDir, "curl");
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\${!#}"
`,
      "utf8",
    );
    await chmod(curl, 0o755);

    const { stdout } = await execFileAsync(
      "bash",
      [
        agentReachScript,
        "https://example.com/article?id=42&utm_source=discord#section",
      ],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(stdout.trim()).toBe(
      "https://r.jina.ai/https://example.com/article?id=42&utm_source=discord",
    );
  });
});

describe("agent-reach.sh destination/IP validation", () => {
  let testDir: string;
  let binDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-reach-shell-network-"));
    binDir = join(testDir, "bin");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "curl"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'fixture response\\n'
`,
      "utf8",
    );
    await chmod(join(binDir, "curl"), 0o755);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.each(networkCases)("$name: $address", async ({
    address,
    public: expected,
  }) => {
    const host = address.includes(":") ? `[${address}]` : address;
    const result = execFileAsync(
      "bash",
      [agentReachScript, `https://${host}/article`],
      { env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
    );

    if (expected) {
      await expect(result).resolves.toBeDefined();
    } else {
      await expect(result).rejects.toMatchObject({
        stderr: expect.stringContaining("internal destination is not allowed"),
      });
    }
  });

  it("checks every DNS answer and rejects a mixed public/private result", async () => {
    const dig = join(binDir, "dig");
    await writeFile(
      dig,
      `#!/usr/bin/env bash
set -euo pipefail
record_type="\${@: -1}"
printf '%s\\n' ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1'
if [[ "$record_type" == A ]]; then
  printf '%s\\n' 'mixed.example. 60 IN A 8.8.8.8' 'mixed.example. 60 IN A 100.127.255.255'
fi
`,
      "utf8",
    );
    await chmod(dig, 0o755);

    await expect(
      execFileAsync(
        "bash",
        [agentReachScript, "https://mixed.example/feed.xml"],
        {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("100.127.255.255"),
    });
  });

  it("queries A and AAAA and rejects a prohibited AAAA answer", async () => {
    const dig = join(binDir, "dig");
    const callLog = join(testDir, "dig-calls.log");
    await writeFile(
      dig,
      `#!/usr/bin/env bash
set -euo pipefail
record_type="\${@: -1}"
host="\${@: -2:1}"
printf '%s %s\\n' "$record_type" "$host" >> "$AGENT_REACH_DIG_CALLS"
printf '%s\\n' ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1'
case "$record_type" in
  A) printf '%s\\n' 'mixed-family.example. 60 IN A 8.8.8.8' ;;
  AAAA) printf '%s\\n' 'mixed-family.example. 60 IN AAAA fc00::1' ;;
  *) exit 1 ;;
esac
`,
      "utf8",
    );
    await chmod(dig, 0o755);

    await expect(
      execFileAsync(
        "bash",
        [agentReachScript, "https://mixed-family.example/feed.xml"],
        {
          env: {
            ...process.env,
            AGENT_REACH_DIG_CALLS: callLog,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
          },
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("fc00::1"),
    });

    await expect(readFile(callLog, "utf8")).resolves.toEqual(
      "A mixed-family.example\nAAAA mixed-family.example\n",
    );
  });

  it.each([
    {
      name: "IPv4-only host with successful AAAA NODATA",
      host: "ipv4-only.example",
      recordType: "A",
      absentType: "AAAA",
      absentStatus: "NOERROR",
      address: "8.8.8.8",
    },
    {
      name: "IPv6-only host with successful A NODATA",
      host: "ipv6-only.example",
      recordType: "AAAA",
      absentType: "A",
      absentStatus: "NOERROR",
      address: "2001:4860:4860::8888",
    },
    {
      name: "public family with successful NXDOMAIN on the other query",
      host: "nxdomain-family.example",
      recordType: "A",
      absentType: "AAAA",
      absentStatus: "NXDOMAIN",
      address: "8.8.4.4",
    },
  ])("allows a valid $name when the other family is absent", async ({
    host,
    recordType,
    absentType,
    absentStatus,
    address,
  }) => {
    const dig = join(binDir, "dig");
    await writeFile(
      dig,
      `#!/usr/bin/env bash
set -euo pipefail
record_type="\${@: -1}"
case "$record_type" in
  ${recordType})
    printf '%s\\n' ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1'
    printf '%s\\n' '${host}. 60 IN ${recordType} ${address}'
    ;;
  ${absentType})
    printf '%s\\n' ';; ->>HEADER<<- opcode: QUERY, status: ${absentStatus}, id: 1'
    ;;
  *) exit 1 ;;
esac
`,
      "utf8",
    );
    await chmod(dig, 0o755);

    await expect(
      execFileAsync("bash", [agentReachScript, `https://${host}/article`], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      }),
    ).resolves.toBeDefined();
  });

  it("fails closed when one address family resolver query exits unsuccessfully", async () => {
    const dig = join(binDir, "dig");
    await writeFile(
      dig,
      `#!/usr/bin/env bash
set -euo pipefail
record_type="\${@: -1}"
case "$record_type" in
  A)
    printf '%s\\n' ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1'
    printf '%s\\n' 'family-error.example. 60 IN A 8.8.8.8'
    ;;
  AAAA) exit 1 ;;
  *) exit 1 ;;
esac
`,
      "utf8",
    );
    await chmod(dig, 0o755);

    await expect(
      execFileAsync(
        "bash",
        [agentReachScript, "https://family-error.example/feed.xml"],
        {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("DNS resolution failed"),
    });
  });

  it("fails closed when dig is unavailable", async () => {
    await expect(
      execFileAsync(
        "/bin/bash",
        [agentReachScript, "https://missing-dig.example/feed.xml"],
        { env: { ...process.env, PATH: binDir } },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("DNS validation unavailable"),
    });
  });

  it("fails closed when DNS resolution exits unsuccessfully or returns no addresses", async () => {
    const dig = join(binDir, "dig");
    await writeFile(
      dig,
      `#!/usr/bin/env bash
set -euo pipefail
host="\${@: -2:1}"
record_type="\${@: -1}"
case "$host" in
  broken.example) exit 2 ;;
  empty.example)
    printf '%s\\n' ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1'
    exit 0
    ;;
esac
printf '%s\\n' ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1'
case "$record_type" in
  A) printf '%s\\n' 'public.example. 60 IN A 8.8.8.8' ;;
  AAAA) printf '%s\\n' 'public.example. 60 IN AAAA 2001:4860:4860::8888' ;;
  *) exit 1 ;;
esac
`,
      "utf8",
    );
    await chmod(dig, 0o755);

    for (const host of ["broken.example", "empty.example"]) {
      await expect(
        execFileAsync("bash", [agentReachScript, `https://${host}/feed.xml`], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        }),
      ).rejects.toBeDefined();
    }
  });

  it("fails closed when one address family returns SERVFAIL", async () => {
    const dig = join(binDir, "dig");
    await writeFile(
      dig,
      `#!/usr/bin/env bash
set -euo pipefail
record_type="\${@: -1}"
case "$record_type" in
  A)
    printf '%s\\n' ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1'
    printf '%s\\n' 'status-error.example. 60 IN A 8.8.8.8'
    ;;
  AAAA) printf '%s\\n' ';; ->>HEADER<<- opcode: QUERY, status: SERVFAIL, id: 1' ;;
  *) exit 1 ;;
esac
`,
      "utf8",
    );
    await chmod(dig, 0o755);

    await expect(
      execFileAsync(
        "bash",
        [agentReachScript, "https://status-error.example/feed.xml"],
        {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("status SERVFAIL"),
    });
  });

  it("fetches a public RSS feed through multiple validated redirects", async () => {
    const requestLog = join(testDir, "rss-requests.log");
    const parseMarker = join(testDir, "rss-parse-marker");
    await installRssPythonFixtures(testDir, {
      "https://8.8.8.8/feed.xml": {
        status: 302,
        location: "https://8.8.4.4/step.xml",
      },
      "https://8.8.4.4/step.xml": {
        status: 301,
        location: "https://1.1.1.1/final.xml",
      },
      "https://1.1.1.1/final.xml": {
        status: 200,
        body: "<rss><channel><title>fixture</title></channel></rss>",
      },
    });

    const { stdout } = await execFileAsync(
      "bash",
      [agentReachScript, "https://8.8.8.8/feed.xml"],
      {
        env: {
          ...process.env,
          AGENT_REACH_RSS_REQUEST_LOG: requestLog,
          AGENT_REACH_RSS_PARSE_MARKER: parseMarker,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          PYTHONPATH: testDir,
        },
      },
    );

    await expect(readFile(requestLog, "utf8")).resolves.toBe(
      "https://8.8.8.8/feed.xml\nhttps://8.8.4.4/step.xml\nhttps://1.1.1.1/final.xml\n",
    );
    await expect(readFile(parseMarker, "utf8")).resolves.toBe("bytes");
    expect(stdout).toContain('"title": "validated RSS"');
  });

  it("rejects private RSS destinations before opening initial or redirect URLs", async () => {
    const requestLog = join(testDir, "rss-private-requests.log");
    await installRssPythonFixtures(testDir, {
      "https://8.8.8.8/feed.xml": {
        status: 302,
        location: "http://127.0.0.1/private.xml",
      },
    });
    const env = {
      ...process.env,
      AGENT_REACH_RSS_REQUEST_LOG: requestLog,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PYTHONPATH: testDir,
    };

    await expect(
      execFileAsync("bash", [agentReachScript, "https://8.8.8.8/feed.xml"], {
        env,
      }),
    ).rejects.toBeDefined();
    await expect(readFile(requestLog, "utf8")).resolves.toBe(
      "https://8.8.8.8/feed.xml\n",
    );

    await expect(
      execFileAsync("bash", [agentReachScript, "http://127.0.0.1/feed.xml"], {
        env,
      }),
    ).rejects.toBeDefined();
    await expect(readFile(requestLog, "utf8")).resolves.toBe(
      "https://8.8.8.8/feed.xml\n",
    );
  });

  it("guards yt-dlp secondary DNS lookups", async () => {
    await installPublicDig(binDir);
    const marker = join(testDir, "yt-dlp-guard-marker");
    const ytDlp = join(binDir, "yt-dlp");

    for (const destination of [
      "http://localhost:9/private",
      "http://[2001:db8::1]/private",
    ]) {
      await writeFile(
        ytDlp,
        `#!/usr/bin/env python3\nimport os\nimport urllib.request\n\ntry:\n    urllib.request.urlopen("${destination}")\nexcept Exception as error:\n    with open(os.environ["AGENT_REACH_GUARD_MARKER"], "w") as output:\n        output.write(str(error))\n    raise\n`,
        "utf8",
      );
      await chmod(ytDlp, 0o755);

      await expect(
        execFileAsync(
          "bash",
          [agentReachScript, "https://www.youtube.com/watch?v=fixture"],
          {
            env: {
              ...process.env,
              AGENT_REACH_GUARD_MARKER: marker,
              PATH: `${binDir}:${process.env.PATH ?? ""}`,
            },
          },
        ),
      ).rejects.toBeDefined();
      await expect(readFile(marker, "utf8")).resolves.toContain(
        "non-public destination rejected",
      );
    }
  });
});

describe("agent-reach.sh temporary directories", () => {
  let testDir: string;
  let binDir: string;
  let tempRoot: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-reach-shell-temp-"));
    binDir = join(testDir, "bin");
    tempRoot = join(testDir, "tmp");
    await mkdir(binDir);
    await mkdir(tempRoot);
    await installPublicDig(binDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("uses an isolated system-temp directory and cleans it after success", async () => {
    const requestLogPath = join(testDir, "output-paths.log");
    const ytDlp = join(binDir, "yt-dlp");
    await writeFile(
      ytDlp,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --dump-json "* ]]; then
  printf '%s\\n' '{"title":"test","chapters":[]}'
  exit 0
fi
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    output="$2"
    break
  fi
  shift
done
printf '%s\\n' "$output" >> "$AGENT_REACH_OUTPUT_PATHS"
`,
      "utf8",
    );
    await chmod(ytDlp, 0o755);

    await execFileAsync(
      "bash",
      [agentReachScript, "https://www.youtube.com/watch?v=test"],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          TMPDIR: tempRoot,
          AGENT_REACH_OUTPUT_PATHS: requestLogPath,
        },
      },
    );

    const outputPath = (await readFile(requestLogPath, "utf8")).trim();
    const callDir = dirname(dirname(outputPath));
    expect(callDir.startsWith(`${tempRoot}/agent-reach-`)).toBe(true);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("isolates concurrent calls and cleans both directories on success", async () => {
    const requestLogPath = join(testDir, "output-paths.log");
    const ytDlp = join(binDir, "yt-dlp");
    await writeFile(
      ytDlp,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --dump-json "* ]]; then
  printf '%s\\n' '{"title":"test","chapters":[]}'
  exit 0
fi
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-o" ]]; then
    output="$2"
    break
  fi
  shift
done
printf '%s\\n' "$output" >> "$AGENT_REACH_OUTPUT_PATHS"
sleep 0.05
`,
      "utf8",
    );
    await chmod(ytDlp, 0o755);

    const env = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      TMPDIR: tempRoot,
      AGENT_REACH_OUTPUT_PATHS: requestLogPath,
    };
    await Promise.all([
      execFileAsync(
        "bash",
        [agentReachScript, "https://www.youtube.com/watch?v=one"],
        { env },
      ),
      execFileAsync(
        "bash",
        [agentReachScript, "https://www.youtube.com/watch?v=two"],
        { env },
      ),
    ]);

    const outputPaths = (await readFile(requestLogPath, "utf8"))
      .trim()
      .split("\n");
    const callDirs = outputPaths.map((path) => dirname(dirname(path)));
    expect(callDirs).toHaveLength(2);
    expect(new Set(callDirs).size).toBe(2);
    expect(
      callDirs.every((path) => path.startsWith(`${tempRoot}/agent-reach-`)),
    ).toBe(true);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("cleans the call-scoped directory after a fetch failure", async () => {
    const ytDlp = join(binDir, "yt-dlp");
    await writeFile(
      ytDlp,
      `#!/usr/bin/env bash
set -euo pipefail
exit 1
`,
      "utf8",
    );
    await chmod(ytDlp, 0o755);

    await expect(
      execFileAsync(
        "bash",
        [agentReachScript, "https://www.youtube.com/watch?v=failure"],
        {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            TMPDIR: tempRoot,
          },
        },
      ),
    ).rejects.toBeDefined();

    expect(await readdir(tempRoot)).toEqual([]);
  });
});

describe("agent-reach.sh shared parity fixtures", () => {
  let testDir: string;
  let binDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-reach-shell-parity-"));
    binDir = join(testDir, "bin");
    await mkdir(binDir);
    await installPublicDig(binDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it.each([
    {
      name: "X post",
      url: parityCases.xPost.url,
      payload: parityCases.xPost.payload,
      expectedOutput: parityCases.xPost.expectedOutput,
    },
    {
      name: parityCases.xArticle.name,
      url: parityCases.xPost.url,
      payload: parityCases.xArticle.payload,
      expectedOutput: parityCases.xArticle.expectedOutput,
    },
    {
      name: parityCases.previewOnly.name,
      url: parityCases.xPost.url,
      payload: parityCases.previewOnly.payload,
      expectedOutput: parityCases.previewOnly.expectedOutput,
    },
    ...parityCases.formattedCases,
  ])("$name has the canonical formatted stdout", async (fixture) => {
    const payloadPath = join(testDir, "x-post.json");
    const requestLogPath = join(testDir, "request-url");
    const curl = join(binDir, "curl");
    await writeFile(payloadPath, JSON.stringify(fixture.payload), "utf8");
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s' "$url" > "$AGENT_REACH_REQUEST_LOG"
if [[ -n "$output" ]]; then
  cat "$AGENT_REACH_FIXTURE" > "$output"
  printf '200\\napplication/json'
else
  cat "$AGENT_REACH_FIXTURE"
fi
`,
      "utf8",
    );
    await chmod(curl, 0o755);

    const { stdout } = await execFileAsync(
      "bash",
      [agentReachScript, parityCases.xPost.url],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          AGENT_REACH_FIXTURE: payloadPath,
          AGENT_REACH_REQUEST_LOG: requestLogPath,
        },
      },
    );

    // The shell entry point is line-oriented and emits one terminal newline;
    // the tool formatter returns the same content without that transport newline.
    expect(stdout.replace(/\n$/, "")).toBe(fixture.expectedOutput);
    expect(await readFile(requestLogPath, "utf8")).toBe(
      "https://api.fxtwitter.com/fixture_user/status/123456789",
    );
  });

  it("FxTwitter fetch has timeout, redirect, and response-size bounds", async () => {
    const payloadPath = join(testDir, "bounded-response.json");
    const argsLogPath = join(testDir, "fxtwitter-args.log");
    const curl = join(binDir, "curl");
    await writeFile(
      payloadPath,
      JSON.stringify(parityCases.xPost.payload),
      "utf8",
    );
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > "$AGENT_REACH_CURL_ARGS"
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat "$AGENT_REACH_FIXTURE" > "$output"
printf '200\\napplication/json'
`,
      "utf8",
    );
    await chmod(curl, 0o755);

    await expect(
      execFileAsync("bash", [agentReachScript, parityCases.xPost.url], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          AGENT_REACH_FIXTURE: payloadPath,
          AGENT_REACH_CURL_ARGS: argsLogPath,
        },
      }),
    ).resolves.toBeDefined();

    const args = await readFile(argsLogPath, "utf8");
    expect(args).toContain("--max-time 20");
    expect(args).toContain("--connect-timeout 20");
    expect(args).toContain("--max-redirs 0");
    expect(args).toContain("--max-filesize 2097152");
  });

  it("Article blocks の上限を拒否する", async () => {
    const payloadPath = join(testDir, "too-many-blocks.json");
    const curl = join(binDir, "curl");
    await writeFile(
      payloadPath,
      JSON.stringify({
        code: 200,
        tweet: {
          article: {
            content: {
              blocks: Array.from({ length: 2001 }, () => ({
                type: "unstyled",
                text: "block",
              })),
            },
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat "$AGENT_REACH_FIXTURE" > "$output"
printf '200\\napplication/json'
`,
      "utf8",
    );
    await chmod(curl, 0o755);

    await expect(
      execFileAsync("bash", [agentReachScript, parityCases.xPost.url], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          AGENT_REACH_FIXTURE: payloadPath,
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("invalid response schema"),
    });
  });

  it("Article本文を120,000文字で切り詰め、共通注記を出力する", async () => {
    const fixture = parityCases.articleTruncation;
    const payloadPath = join(testDir, "long-article.json");
    const curl = join(binDir, "curl");
    await writeFile(
      payloadPath,
      JSON.stringify({
        code: 200,
        tweet: {
          text: "",
          author: { screen_name: "long_article" },
          article: {
            title: fixture.title,
            content: {
              blocks: [
                {
                  type: fixture.blockType,
                  text: "x".repeat(fixture.bodyLength),
                },
              ],
            },
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat "$AGENT_REACH_FIXTURE" > "$output"
printf '200\\napplication/json'
`,
      "utf8",
    );
    await chmod(curl, 0o755);

    const { stdout } = await execFileAsync(
      "bash",
      [agentReachScript, parityCases.xPost.url],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          AGENT_REACH_FIXTURE: payloadPath,
        },
      },
    );

    const output = stdout.replace(/\\n$/, "");
    expect(output).toContain(fixture.expectedNotice);
    expect(output).toContain("x".repeat(120000));
    expect(output).not.toContain("x".repeat(120001));
  });

  it.each([
    ["http://x.com/fixture_user/status/123", "must use HTTPS"],
    ["https://user:pass@x.com/fixture_user/status/123", "credentials"],
    ["https://x.com:443/fixture_user/status/123", "credentials"],
  ])("rejects unsafe X URL %s", async (url, message) => {
    const curl = join(binDir, "curl");
    await writeFile(
      curl,
      "#!/usr/bin/env bash\nset -euo pipefail\nexit 1\n",
      "utf8",
    );
    await chmod(curl, 0o755);

    await expect(
      execFileAsync("bash", [agentReachScript, url], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining(message) });
  });

  it("preserves HTTP status evidence instead of formatting an error body", async () => {
    const payloadPath = join(testDir, "http-error.json");
    const curl = join(binDir, "curl");
    await writeFile(payloadPath, '{"code":500}', "utf8");
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat "$AGENT_REACH_FIXTURE" > "$output"
printf '500\\napplication/json'
`,
      "utf8",
    );
    await chmod(curl, 0o755);

    await expect(
      execFileAsync("bash", [agentReachScript, parityCases.xPost.url], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          AGENT_REACH_FIXTURE: payloadPath,
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("HTTP 500"),
    });
  });

  it("FxTwitter failure does not consult Credential Proxy", async () => {
    const requestLogPath = join(testDir, "fx-failure-requests.log");
    const curl = join(binDir, "curl");
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) printf '%s\\n' "$arg" >> "$AGENT_REACH_REQUEST_LOG" ;;
  esac
done
exit 1
`,
      "utf8",
    );
    await chmod(curl, 0o755);

    await expect(
      execFileAsync("bash", [agentReachScript, parityCases.xPost.url], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          AGENT_REACH_REQUEST_LOG: requestLogPath,
          CREDENTIAL_PROXY_JSON: JSON.stringify([
            { provider: "x-article", baseUrl: "http://proxy.invalid/x" },
          ]),
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("FxTwitter API"),
    });
    await expect(readFile(requestLogPath, "utf8")).resolves.toBe(
      "https://api.fxtwitter.com/fixture_user/status/123456789\n",
    );
  });

  it.each(
    parityCases.responseCases,
  )("$name: malformed, oversized, and invalid responses are rejected", async (fixture) => {
    const payloadPath = join(testDir, "response-fixture");
    const curl = join(binDir, "curl");
    const body =
      fixture.kind === "oversized"
        ? "x".repeat(fixture.bodyBytes ?? 0)
        : (fixture.body ?? "");
    await writeFile(payloadPath, body, "utf8");
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat "$AGENT_REACH_FIXTURE" > "$output"
printf '200\\n%s' "$AGENT_REACH_CONTENT_TYPE"
`,
      "utf8",
    );
    await chmod(curl, 0o755);

    await expect(
      execFileAsync("bash", [agentReachScript, parityCases.xPost.url], {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          AGENT_REACH_FIXTURE: payloadPath,
          AGENT_REACH_CONTENT_TYPE: fixture.contentType,
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(fixture.expectedError),
    });
  });

  it.each(
    parityCases.urlCases,
  )("$name executes through the shell with the canonical normalized URL", async ({
    input,
    normalized,
    service,
  }) => {
    const requestLogPath = join(testDir, "requests.log");
    const payloadPath = join(testDir, "x-post.json");
    const curl = join(binDir, "curl");
    const ytDlp = join(binDir, "yt-dlp");
    const python3 = join(binDir, "python3");

    await writeFile(
      payloadPath,
      JSON.stringify(parityCases.xPost.payload),
      "utf8",
    );
    await writeFile(
      curl,
      `#!/usr/bin/env bash
set -euo pipefail
url=""
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$AGENT_REACH_REQUEST_LOG"
case "$url" in
  https://api.fxtwitter.com/*)
    if [[ -n "$output" ]]; then
      cat "$AGENT_REACH_FIXTURE" > "$output"
      printf '200\\napplication/json'
    else
      cat "$AGENT_REACH_FIXTURE"
    fi
    ;;
  https://api.github.com/repos/*/readme) : ;;
  https://api.github.com/repos/*) printf '%s\\n' '{"full_name":"owner/repo"}' ;;
  http://localhost:12345/reddit/*) printf '%s\\n' '{"data":{"children":[]}}' ;;
  *) printf '%s\\n' "$url" ;;
esac
`,
      "utf8",
    );
    await writeFile(
      ytDlp,
      `#!/usr/bin/env bash
set -euo pipefail
url=""
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
done
printf 'yt-dlp %s\\n' "$url" >> "$AGENT_REACH_REQUEST_LOG"
if [[ " $* " == *" --dump-json "* ]]; then
  printf '%s\\n' '{"title":"fixture","chapters":[]}'
fi
`,
      "utf8",
    );
    await writeFile(
      python3,
      `#!/usr/bin/env bash
set -euo pipefail
url=""
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
done
if [[ -n "$url" ]]; then
  printf 'python3 %s\\n' "$url" >> "$AGENT_REACH_REQUEST_LOG"
fi
printf '%s\\n' '[]'
`,
      "utf8",
    );
    await Promise.all([curl, ytDlp, python3].map((path) => chmod(path, 0o755)));

    await execFileAsync("bash", [agentReachScript, input], {
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        AGENT_REACH_FIXTURE: payloadPath,
        AGENT_REACH_REQUEST_LOG: requestLogPath,
        CREDENTIAL_PROXY_JSON: JSON.stringify([
          { provider: "reddit", baseUrl: "http://localhost:12345/reddit" },
        ]),
      },
    });

    const parsed = new URL(normalized);
    let expectedRequest: string;
    switch (service) {
      case "web":
        expectedRequest = `https://r.jina.ai/${normalized}`;
        break;
      case "youtube":
      case "rss":
        expectedRequest = normalized;
        break;
      case "github-repo":
        expectedRequest = `https://api.github.com/repos${parsed.pathname}`;
        break;
      case "reddit": {
        const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
        expectedRequest = `http://localhost:12345/reddit${pathname.endsWith(".json") ? pathname : `${pathname}.json`}${parsed.search}`;
        break;
      }
      case "x-twitter": {
        const match = /^\/([^/]+)\/status\/(\d+)/.exec(parsed.pathname);
        if (!match) throw new Error(`invalid X fixture path: ${normalized}`);
        expectedRequest = `https://api.fxtwitter.com/${match[1]}/status/${match[2]}`;
        break;
      }
      default:
        throw new Error(`unsupported parity service: ${service}`);
    }

    expect(await readFile(requestLogPath, "utf8")).toContain(expectedRequest);
  });

  it.each(
    parityCases.errorCases.map(({ name, url, scriptMessage }) => ({
      name,
      url,
      message: scriptMessage,
    })),
  )("$name uses a non-zero exit and canonical error category", async ({
    url,
    message,
  }) => {
    await expect(
      execFileAsync("bash", [agentReachScript, url], {
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(message),
    });
  });
});
