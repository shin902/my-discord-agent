import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type * as http from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cancelAgentReachRuntime,
  executeAgentReachRuntime,
} from "./agent-reach-client.js";
import { createAgentReachRuntimeServer } from "./agent-reach-runtime.js";

const temporaryDirectories: string[] = [];
const originalEnvironment = {
  AGENT_REACH_RUNTIME_TOKEN: process.env.AGENT_REACH_RUNTIME_TOKEN,
  AGENT_REACH_RUNTIME_URL: process.env.AGENT_REACH_RUNTIME_URL,
  FAKE_YTDLP_MARKER: process.env.FAKE_YTDLP_MARKER,
  FAKE_YTDLP_STATE: process.env.FAKE_YTDLP_STATE,
  FAKE_YTDLP_GROUP: process.env.FAKE_YTDLP_GROUP,
  PATH: process.env.PATH,
};

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  return address.port;
}

async function waitForSettlement(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([
    promise.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function killForCleanup(
  pid: number | undefined,
  processGroup: number | undefined,
): void {
  if (processGroup !== undefined && processGroup > 1) {
    try {
      process.kill(-processGroup, "SIGKILL");
    } catch {
      // The group may already have exited.
    }
  }
  if (pid !== undefined) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The descendant may already have exited.
    }
  }
}

async function closeServerSafely(server: http.Server): Promise<void> {
  let closed = false;
  const close = new Promise<void>((resolve) => {
    try {
      server.close(() => {
        closed = true;
        resolve();
      });
    } catch {
      closed = true;
      resolve();
    }
  });
  await Promise.race([
    close,
    new Promise<void>((resolve) => setTimeout(resolve, 500)),
  ]);
  if (!closed) {
    server.closeAllConnections();
    server.closeIdleConnections();
    await Promise.race([
      close,
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ]);
  }
}

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("agent-reach Runtime cancellation boundary", () => {
  it("revoke aborts a real yt-dlp-like descendant and leaves Runtime usable", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "agent-reach-runtime-integration-"),
    );
    temporaryDirectories.push(directory);
    const marker = join(directory, "descendant.pid");
    const groupMarker = join(directory, "process-group.pid");
    const state = join(directory, "state");
    const fakeYtDlp = join(directory, "yt-dlp");
    await writeFile(
      fakeYtDlp,
      `#!/bin/sh
set -eu
is_metadata=false
for arg in "$@"; do
  [ "$arg" = "--dump-json" ] && is_metadata=true
done
if [ "$is_metadata" = true ]; then
  printf '%s\\n' '{"id":"fixture","title":"fixture","channel":"fixture"}'
  exit 0
fi
if [ -f "$FAKE_YTDLP_STATE" ]; then
  exit 0
fi
: > "$FAKE_YTDLP_STATE"
ps -o pgid= -p "$$" | tr -d ' ' > "$FAKE_YTDLP_GROUP"
node -e 'setInterval(() => {}, 1000)' &
child=$!
printf '%s\\n' "$child" > "$FAKE_YTDLP_MARKER"
wait "$child"
`,
      { mode: 0o700 },
    );
    await chmod(fakeYtDlp, 0o700);
    process.env.AGENT_REACH_RUNTIME_TOKEN = "runtime-test-token";
    process.env.FAKE_YTDLP_MARKER = marker;
    process.env.FAKE_YTDLP_STATE = state;
    process.env.FAKE_YTDLP_GROUP = groupMarker;
    process.env.PATH = `${directory}${delimiter}${originalEnvironment.PATH ?? ""}`;

    const server = createAgentReachRuntimeServer();
    const port = await listen(server);
    process.env.AGENT_REACH_RUNTIME_URL = `http://127.0.0.1:${port}`;
    let callId: string | undefined;
    let pending: Promise<unknown> | undefined;
    let descendantPid: number | undefined;
    let processGroup: number | undefined;
    try {
      callId = "integration-revoke-call";
      pending = executeAgentReachRuntime(
        "https://youtube.com/watch?v=fixture",
        callId,
      );
      await waitForFile(marker);
      descendantPid = Number.parseInt(await readFile(marker, "utf8"), 10);
      processGroup = Number.parseInt(await readFile(groupMarker, "utf8"), 10);
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(Number.isInteger(processGroup)).toBe(true);
      expect(await processExists(descendantPid)).toBe(true);

      await cancelAgentReachRuntime(callId);
      await expect(pending).rejects.toThrow("The operation was aborted");

      for (
        let attempt = 0;
        attempt < 100 && (await processExists(descendantPid));
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await processExists(descendantPid)).toBe(false);

      const subsequent = await executeAgentReachRuntime(
        "https://youtube.com/watch?v=fixture",
        "integration-follow-up-call",
      );
      expect(subsequent.content?.[0]).toEqual({
        type: "text",
        text: "# fixture\n\n**チャンネル**: fixture\n\n## 字幕\n\n(取得できませんでした)",
      });
    } finally {
      if (pending) {
        if (callId) {
          await Promise.race([
            cancelAgentReachRuntime(callId),
            new Promise<void>((resolve) => setTimeout(resolve, 500)),
          ]).catch(() => undefined);
        }
        await waitForSettlement(pending, 1_000);
      }
      killForCleanup(descendantPid, processGroup);
      await closeServerSafely(server);
    }
  });
});
