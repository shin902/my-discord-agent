import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
