import { spawn } from "node:child_process";
import { chmod, type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const TIMEOUT_MS = 30_000;
const PREVIEW_BYTES = 32 * 1024;

const parameters = Type.Object({
  command: Type.String({ description: "Shell command to execute." }),
});

export const bashTool: AgentTool<typeof parameters> = {
  name: "bash",
  label: "Bash",
  description:
    "Run a shell command with a 30-second timeout. Large output returns a bounded head preview and a full output file under /tmp, valid only for the current container run. stdout/stderr share one stream. Prefer a dedicated tool such as agent-reach when fetching content from URLs.",
  parameters,
  execute: async (_toolCallId, { command }, signal) => {
    signal?.throwIfAborted();
    const directory = await mkdtemp("/tmp/my-discord-agent-bash-");
    const fullOutputPath = join(directory, "output.txt");
    // Prepare storage before starting a producer. Never publish a failed capture.
    let file: FileHandle;
    try {
      await chmod(directory, 0o700);
      file = await open(fullOutputPath, "wx", 0o600);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("Output storage failed; capture discarded", {
        cause: error,
      });
    }

    const preview = Buffer.alloc(PREVIEW_BYTES);
    let previewBytes = 0;
    let totalBytes = 0;
    let failure: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await chmod(fullOutputPath, 0o600);
      // Merge at the shell's file descriptor boundary, not by buffering two
      // streams. Bytes retain pipe arrival order; stderr has no added label.
      const child = spawn("/bin/sh", ["-c", `exec 2>&1\n${command}`], {
        cwd: "/workspace",
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const terminate = (reason: string) => {
        failure ??= reason;
        if (child.pid === undefined) return;
        try {
          // Kill the whole call-scoped group, including producers ignoring TERM.
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            child.kill("SIGKILL");
          }
        }
      };
      const closed = new Promise<void>((resolve) => {
        child.once("error", (error) => {
          failure ??= error.message;
        });
        child.once("close", (code, exitSignal) => {
          if (code !== 0) {
            failure ??= `Command failed (${exitSignal ?? `exit ${code}`})`;
          }
          resolve();
        });
      });
      timer = setTimeout(() => terminate("Command timed out"), TIMEOUT_MS);
      onAbort = () => terminate("Command aborted");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      const saved = pipeline(
        child.stdout,
        async function* (source) {
          for await (const chunk of source) {
            const bytes = chunk as Buffer;
            totalBytes += bytes.length;
            previewBytes += bytes.copy(preview, previewBytes);
            yield bytes;
          }
        },
        file.createWriteStream(),
      ).catch((error: unknown) => {
        terminate("Output storage failed");
        return error;
      });
      const [, storageError] = await Promise.all([closed, saved]);
      if (storageError)
        throw new Error("Output storage failed; capture discarded", {
          cause: storageError,
        });
    } catch (error) {
      try {
        await file.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }

    const truncated = totalBytes > PREVIEW_BYTES;
    const details = {
      command,
      fullOutputPath,
      totalBytes,
      truncated,
      previewBytes,
      lifetime: "container-run",
    };
    const text =
      preview.subarray(0, previewBytes).toString("utf8").trim() || "(出力なし)";
    const notice = `Full output: ${fullOutputPath}\nSize: ${totalBytes} bytes${truncated ? ` (head preview: ${previewBytes} bytes)` : ""}\nThis /tmp path is valid only for the current container run.`;
    if (failure) {
      // The agent SDK renders thrown errors as failed tool results, so the
      // locator must be in the message, not only attached metadata.
      throw Object.assign(new Error(`${failure}\n${text}\n\n${notice}`), {
        details,
      });
    }
    return {
      content: [
        { type: "text", text: truncated ? `${text}\n\n${notice}` : text },
      ],
      details,
    };
  },
};
