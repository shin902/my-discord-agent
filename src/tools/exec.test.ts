import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execAsync } from "./exec.js";

const temporaryDirectories: string[] = [];

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("execAsync process groups", () => {
  it.runIf(process.platform !== "win32")(
    "abort terminates the shell and its descendant process",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "exec-process-group-"));
      temporaryDirectories.push(directory);
      const shellPidFile = join(directory, "shell.pid");
      const descendantPidFile = join(directory, "descendant.pid");
      const quotedShellPidFile = JSON.stringify(shellPidFile);
      const quotedDescendantPidFile = JSON.stringify(descendantPidFile);
      const controller = new AbortController();
      const command = `echo $$ > ${quotedShellPidFile}; node -e 'setInterval(() => {}, 1000)' & echo $! > ${quotedDescendantPidFile}; wait`;
      const pending = execAsync(command, {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        cwd: directory,
        signal: controller.signal,
        processGroup: true,
      });

      await waitForFile(descendantPidFile);
      const shellPid = Number.parseInt(
        await readFile(shellPidFile, "utf8"),
        10,
      );
      const descendantPid = Number.parseInt(
        await readFile(descendantPidFile, "utf8"),
        10,
      );
      expect(Number.isInteger(shellPid)).toBe(true);
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(await processExists(shellPid)).toBe(true);
      expect(await processExists(descendantPid)).toBe(true);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });

      for (
        let attempt = 0;
        attempt < 100 &&
        ((await processExists(shellPid)) ||
          (await processExists(descendantPid)));
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await processExists(shellPid)).toBe(false);
      expect(await processExists(descendantPid)).toBe(false);
    },
  );
});
