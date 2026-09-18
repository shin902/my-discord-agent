import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("installs, updates, reports, and removes the screen capture LaunchAgent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "screen-launch-agent-"));
  const script = path.resolve("scripts/capture-screen.sh");
  const url = "https://bot.example.ts.net:8444/v1/screen-captures";
  const calls = path.join(root, "launchctl-calls");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    PATH: `${root}:${process.env.PATH}`,
  };
  const run = (...args: string[]) =>
    spawnSync("bash", [script, ...args], { encoding: "utf8", env });
  try {
    writeFileSync(
      path.join(root, "launchctl"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$HOME/launchctl-calls"\n[[ "$1" != print || -f "$HOME/loaded" ]] || exit 1\n[[ "$1" != bootstrap ]] || touch "$HOME/loaded"\nif [[ "$1" == bootout ]]; then\n  [[ -z "$FAIL_BOOTOUT" ]] || exit 1\n  rm -f "$HOME/loaded"\nfi\n',
      { mode: 0o700 },
    );
    writeFileSync(path.join(root, "plutil"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o700,
    });
    writeFileSync(
      path.join(root, "shlock"),
      '#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do\n  case "$1" in -f) file=$2; shift 2;; -p) pid=$2; shift 2;; esac\ndone\n(set -o noclobber; printf "%s\\n" "$pid" > "$file") 2>/dev/null\n',
      { mode: 0o700 },
    );

    expect(run("status").status).toBe(1);
    expect(run("on", url, "30").status).toBe(0);
    const plist = path.join(
      root,
      "Library/LaunchAgents/com.my-discord-agent.screen-capture.plist",
    );
    expect(readFileSync(plist, "utf8")).toContain(
      "<key>StartInterval</key><integer>30</integer>",
    );
    expect(run("status").status).toBe(0);
    expect(run("on", url, "300").status).toBe(0);
    expect(readFileSync(plist, "utf8")).toContain(
      "<key>StartInterval</key><integer>300</integer>",
    );
    expect(run("on", url, "0").status).toBe(1);
    env.FAIL_BOOTOUT = "1";
    expect(run("off").status).toBe(1);
    expect(existsSync(plist)).toBe(true);
    delete env.FAIL_BOOTOUT;
    expect(run("off").status).toBe(0);
    expect(existsSync(plist)).toBe(false);
    expect(readFileSync(calls, "utf8")).toContain("bootstrap gui/");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("retains uncertain uploads for same-UUID retries and deletes the PNG only after HTTP 200", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "screen-sender-"));
  const id = "cf7f6080-1faa-49a3-9734-0b4b0b1c0cee";
  const url = "https://bot.example.ts.net:8444/v1/screen-captures";
  const argsFile = path.join(root, "curl-args");
  const magickCalls = path.join(root, "magick-calls");
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${root}:${process.env.PATH}`,
    SCREEN_TEST_ARGS: argsFile,
  };
  function run(
    args: string[],
    status = "200",
    curlExit = 0,
    similarity = "0.2",
    magickExit = 0,
  ) {
    return spawnSync(
      "bash",
      [path.resolve("scripts/capture-screen.sh"), ...args],
      {
        encoding: "utf8",
        env: {
          ...env,
          SCREEN_TEST_STATUS: status,
          SCREEN_TEST_CURL_EXIT: String(curlExit),
          SCREEN_TEST_SIMILARITY: similarity,
          SCREEN_TEST_MAGICK_EXIT: String(magickExit),
        },
      },
    );
  }
  try {
    writeFileSync(
      path.join(root, "uuidgen"),
      `#!/usr/bin/env bash\nprintf '${id}\\n'\n`,
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(root, "screencapture"),
      '#!/usr/bin/env bash\nprintf png > "$5"\n',
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(root, "magick"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$HOME/magick-calls"
if [[ "$*" == *SSIM* ]]; then
  (( SCREEN_TEST_MAGICK_EXIT == 0 )) || exit "$SCREEN_TEST_MAGICK_EXIT"
  printf '%s' "$SCREEN_TEST_SIMILARITY"
  exit 1
fi
input=$1
output=\${!#}
output=\${output#png:}
if (( SCREEN_TEST_MAGICK_EXIT != 0 )); then
  printf partial > "$output"
  exit "$SCREEN_TEST_MAGICK_EXIT"
fi
printf '%s-resized' "$(<"$input")" > "$output"
`,
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(root, "curl"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$SCREEN_TEST_ARGS"\nprintf "%s" "$SCREEN_TEST_STATUS"\nexit "$SCREEN_TEST_CURL_EXIT"\n',
      { mode: 0o700 },
    );
    expect(run(["https://public.example/v1/screen-captures"]).status).toBe(1);
    expect(existsSync(argsFile)).toBe(false);
    const image = path.join(
      root,
      "Library/Application Support/my-discord-agent/screen-captures",
      `${id}.png`,
    );
    expect(run([url], "200", 0, "0.2", 2).status).not.toBe(0);
    expect(existsSync(image)).toBe(false);
    expect(existsSync(`${image}.raw.png`)).toBe(false);
    expect(
      existsSync(path.join(path.dirname(image), `.${id}.png.resize.tmp`)),
    ).toBe(false);
    expect(existsSync(argsFile)).toBe(false);
    const failed = run([url], "503");
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("retained for retry");
    expect(readFileSync(image, "utf8")).toBe("png-resized");
    expect(readFileSync(magickCalls, "utf8").trim().split("\n")).toHaveLength(
      2,
    );
    for (const status of ["302", "409", "500"]) {
      expect(run([url, image], status).status).toBe(1);
      expect(readFileSync(image, "utf8")).toBe("png-resized");
    }
    for (const status of ["000", "200"]) {
      // A transport failure (including an incomplete 200 response) is not an ACK.
      expect(run([url, image], status, 28).status).toBe(1);
      expect(readFileSync(image, "utf8")).toBe("png-resized");
    }
    const retried = run([url, image]);
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain(`Accepted: ${id} (local PNG deleted)`);
    expect(existsSync(image)).toBe(false);
    const args = readFileSync(argsFile, "utf8").trim().split("\n");
    expect(args).toContain(`X-Capture-Id: ${id}`);
    expect(args).toContain(`@${image}`);
    expect(args).toContain("=https");
    expect(args).not.toContain("--location");
    const reference = path.join(
      root,
      "Library/Application Support/my-discord-agent/screen-captures/.last-acknowledged.png",
    );
    expect(readFileSync(reference, "utf8")).toBe("png-resized");
    rmSync(argsFile);
    const skipped = run([url], "200", 0, "0.95");
    expect(skipped.status).toBe(0);
    expect(skipped.stdout).toContain("skipped");
    expect(existsSync(argsFile)).toBe(false);
    expect(existsSync(image)).toBe(false);
    expect(existsSync(`${image}.raw.png`)).toBe(false);
    expect(run([url]).status).toBe(0); // Changed captures use the same ACK cleanup.
    expect(readFileSync(magickCalls, "utf8")).toContain("1280x720>");
    expect(existsSync(image)).toBe(false);

    rmSync(path.dirname(image), { recursive: true });
    const explicit = path.join(root, `${id}.png`);
    writeFileSync(explicit, "explicit");
    expect(run([url, explicit]).status).toBe(0);
    expect(readFileSync(reference, "utf8")).toBe("explicit");

    writeFileSync(path.join(root, "rm"), "#!/usr/bin/env bash\nexit 1\n", {
      mode: 0o700,
    });
    const cleanupFailed = run([url]);
    expect(cleanupFailed.status).toBe(1);
    expect(cleanupFailed.stdout).not.toContain("local PNG deleted");
    expect(existsSync(image)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
