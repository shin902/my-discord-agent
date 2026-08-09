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
import parityCases from "./__fixtures__/agent-reach/parity-cases.json" with {
  type: "json",
};

const execFileAsync = promisify(execFile);
const agentReachScript = join(
  import.meta.dirname,
  "../../templates/SKILLS/agent-reach/scripts/agent-reach.sh",
);
describe("agent-reach.sh YouTube字幕", () => {
  let testDir: string;
  let binDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-reach-shell-test-"));
    binDir = join(testDir, "bin");
    await mkdir(binDir);
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
cat > "$subs_dir/video.ja.vtt" <<'VTT'
WEBVTT
Kind: captions
Language: ja

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

    expect(stdout).toContain("## 字幕 (ja)");
    expect(stdout).toContain("Hello");
    expect(stdout).not.toContain("-->");
  });
});

describe("agent-reach.sh URL 正規化", () => {
  let testDir: string;
  let binDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "agent-reach-shell-test-"));
    binDir = join(testDir, "bin");
    await mkdir(binDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("YouTube 以外の URL では ? 以降を取得先へ渡さない", async () => {
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
      [agentReachScript, "https://example.com/article?utm_source=discord"],
      {
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(stdout.trim()).toBe("https://r.jina.ai/https://example.com/article");
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
printf '%s' "\${!#}" > "$AGENT_REACH_REQUEST_LOG"
cat "$AGENT_REACH_FIXTURE"
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
for arg in "$@"; do
  case "$arg" in
    http://*|https://*) url="$arg" ;;
  esac
done
printf '%s\\n' "$url" >> "$AGENT_REACH_REQUEST_LOG"
case "$url" in
  https://api.fxtwitter.com/*) cat "$AGENT_REACH_FIXTURE" ;;
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
        expectedRequest = `http://localhost:12345/reddit${pathname.endsWith(".json") ? pathname : `${pathname}.json`}`;
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
