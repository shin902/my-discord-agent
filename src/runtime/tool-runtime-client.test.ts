import {
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadToolTimeoutMs } from "../config/tool-config.js";
import { executeToolRuntime } from "./tool-runtime-client.js";

vi.mock("../config/tool-config.js", () => ({
  loadToolTimeoutMs: vi.fn().mockResolvedValue(120_000),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
  execFile: vi.fn(),
}));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

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
    "agent-reach",
    "arxiv-search",
    "arxiv-survey",
    "hackernews-search",
    "github-recent-search",
  ])("uses common timeout rather than a capability timer: %s", async (capability) => {
    vi.useFakeTimers();
    vi.mocked(loadToolTimeoutMs).mockResolvedValueOnce(45_000);
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockReturnValueOnce(
      child as unknown as ChildProcessWithoutNullStreams,
    );
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      child.emit("close", 137);
      (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return child as unknown as ReturnType<typeof execFile>;
    });
    const pending = executeToolRuntime(capability, {
      query: "fixture",
      url: "https://example.com",
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spawn).toHaveBeenCalledOnce();
    expect(execFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toHaveProperty("message", "Tool Runtime timed out");
    const dockerArgs = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(execFile).toHaveBeenCalledWith(
      "docker",
      ["kill", dockerArgs[dockerArgs.indexOf("--name") + 1]],
      { timeout: 5_000 },
      expect.any(Function),
    );
  });

  it("propagates caller cancellation to the exact Runtime container", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    vi.mocked(spawn).mockReturnValueOnce(
      child as unknown as ChildProcessWithoutNullStreams,
    );
    vi.mocked(execFile).mockImplementationOnce((...args: unknown[]) => {
      child.emit("close", 137);
      (args.at(-1) as (error: null, stdout: string, stderr: string) => void)(
        null,
        "",
        "",
      );
      return child as unknown as ReturnType<typeof execFile>;
    });
    const caller = new AbortController();
    const pending = executeToolRuntime(
      "arxiv-search",
      { query: "fixture" },
      caller.signal,
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    caller.abort();
    expect(await pending).toHaveProperty("message", "Tool Runtime aborted");
    expect(execFile).toHaveBeenCalledOnce();
  });
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
