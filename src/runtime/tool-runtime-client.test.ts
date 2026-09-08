import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeToolRuntime } from "./tool-runtime-client.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

function containerExit(code: number, stdout: string, diagnostics: Buffer[]) {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    child.stdin.once("finish", () => {
      for (const chunk of diagnostics) child.stderr.write(chunk);
      child.stderr.end();
      child.stdout.end(stdout);
      child.emit("close", code);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}

const call = () => executeToolRuntime("arxiv-search", { query: "fixture" });

describe("Tool Runtime host diagnostics", () => {
  it.each([
    [125, "", "failed to start or exited unexpectedly"],
    [0, "invalid JSON", "Invalid Tool Runtime response"],
    [0, JSON.stringify({ error: "maintenance failed" }), "maintenance failed"],
  ])("logs stderr on failure without adding it to the caller error (%i, %s)", async (code, stdout, message) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const diagnostic = "setpriv: private host path /fixture/private";
    containerExit(code, stdout, [Buffer.from(diagnostic)]);
    const error = await call().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", expect.stringContaining(message));
    expect(error).toHaveProperty(
      "message",
      expect.not.stringContaining(diagnostic),
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /^\[tool-runtime\] my-discord-agent-tool-.* stderr:$/,
      ),
      diagnostic,
    );
  });

  it("bounds retained stderr across chunks and drains excess output", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    containerExit(125, "", [
      Buffer.alloc(10 * 1024, "a"),
      Buffer.alloc(64 * 1024, "b"),
      Buffer.from("discarded tail"),
    ]);
    await expect(call()).rejects.toThrow("failed to start");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("truncated at 16 KiB"),
      "a".repeat(10 * 1024) + "b".repeat(6 * 1024),
    );
  });

  it("does not log or return stderr for successful calls", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = { content: [{ type: "text", text: "[]" }], details: {} };
    containerExit(0, JSON.stringify({ result }), [
      Buffer.from("private diagnostic"),
    ]);
    await expect(call()).resolves.toEqual(result);
    expect(log).not.toHaveBeenCalled();
  });
});
