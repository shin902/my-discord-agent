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

it("retains uncertain uploads for same-UUID retries and deletes the PNG only after HTTP 200", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "screen-sender-"));
  const id = "cf7f6080-1faa-49a3-9734-0b4b0b1c0cee";
  const url = "https://bot.example.ts.net:8444/v1/screen-captures";
  const argsFile = path.join(root, "curl-args");
  const env = {
    ...process.env,
    HOME: root,
    PATH: `${root}:${process.env.PATH}`,
    SCREEN_TEST_ARGS: argsFile,
  };
  function run(args: string[], status = "200", curlExit = 0) {
    return spawnSync(
      "bash",
      [path.resolve("scripts/capture-screen.sh"), ...args],
      {
        encoding: "utf8",
        env: {
          ...env,
          SCREEN_TEST_STATUS: status,
          SCREEN_TEST_CURL_EXIT: String(curlExit),
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
      path.join(root, "curl"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$SCREEN_TEST_ARGS"\nprintf "%s" "$SCREEN_TEST_STATUS"\nexit "$SCREEN_TEST_CURL_EXIT"\n',
      { mode: 0o700 },
    );
    expect(run(["https://public.example/v1/screen-captures"]).status).toBe(1);
    expect(existsSync(argsFile)).toBe(false);
    const failed = run([url], "503");
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("retained for retry");
    const image = path.join(
      root,
      "Library/Application Support/my-discord-agent/screen-captures",
      `${id}.png`,
    );
    expect(readFileSync(image, "utf8")).toBe("png");
    for (const status of ["302", "409", "500"]) {
      expect(run([url, image], status).status).toBe(1);
      expect(readFileSync(image, "utf8")).toBe("png");
    }
    for (const status of ["000", "200"]) {
      // A transport failure (including an incomplete 200 response) is not an ACK.
      expect(run([url, image], status, 28).status).toBe(1);
      expect(readFileSync(image, "utf8")).toBe("png");
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
    expect(run([url]).status).toBe(0); // Fresh captures use the same ACK cleanup.
    expect(existsSync(image)).toBe(false);
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
