import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    wrapWithSandbox: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getProviders: () => ["provider-a", "opencode-go"],
  getModels: (provider: string) =>
    provider === "opencode-go"
      ? [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
      : [{ id: "model-x", name: "Model X" }],
}));

const { resolveModel, sendMessage } = await import("./manager.js");
const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
const { spawn } = await import("node:child_process");

function makeMockChild(workerResponse: string): ChildProcess {
  const stdin = { write: vi.fn(), end: vi.fn() };
  const stdout = new EventEmitter();
  const child = new EventEmitter();
  Object.assign(child, { stdin, stdout });

  // setImmediate: ミクロタスク（wrapWithSandbox の await 等）が全て完了した後に
  // イベントを発火させることで、sendMessage がハンドラを登録してから届くようにする
  setImmediate(() => {
    stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ response: workerResponse })),
    );
    child.emit("close", 0);
  });

  return child as unknown as ChildProcess;
}

function makeMockChildError(): ChildProcess {
  const stdin = { write: vi.fn(), end: vi.fn() };
  const stdout = new EventEmitter();
  const child = new EventEmitter();
  Object.assign(child, { stdin, stdout });

  setImmediate(() => {
    child.emit("error", new Error("spawn ENOENT"));
  });

  return child as unknown as ChildProcess;
}

describe("resolveModel", () => {
  it("有効なプロバイダとモデルIDはモデルを返す", () => {
    const model = resolveModel("provider-a", "model-x");
    expect(model.id).toBe("model-x");
  });

  it("不明なプロバイダはエラー", () => {
    expect(() => resolveModel("unknown-provider", "model-x")).toThrow(
      "不明なプロバイダ: unknown-provider",
    );
  });

  it("不明なモデルIDはエラー", () => {
    expect(() => resolveModel("provider-a", "unknown-model")).toThrow(
      "不明なモデル: unknown-model (provider: provider-a)",
    );
  });
});

describe("sendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SandboxManager.wrapWithSandbox).mockResolvedValue(
      "sandboxed-cmd",
    );
  });

  it("Worker の返答テキストを返す", async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChild("Hello world"));
    const result = await sendMessage("test-group", "session-1", "こんにちは");
    expect(result).toBe("Hello world");
  });

  it("wrapWithSandbox でコマンドをラップする", async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChild("OK"));
    await sendMessage("test-group", "session-1", "hi");
    expect(SandboxManager.wrapWithSandbox).toHaveBeenCalledOnce();
  });

  it("stdin に groupName/sessionId/content を JSON で渡す", async () => {
    const child = makeMockChild("OK");
    vi.mocked(spawn).mockReturnValue(child);
    await sendMessage("test-group", "session-1", "こんにちは");
    expect((child.stdin as NonNullable<typeof child.stdin>).write).toHaveBeenCalledWith(
      JSON.stringify({
        groupName: "test-group",
        sessionId: "session-1",
        content: "こんにちは",
      }),
    );
  });

  it("spawn エラー時は reject する", async () => {
    vi.mocked(spawn).mockReturnValue(makeMockChildError());
    await expect(sendMessage("test-group", "session-1", "hi")).rejects.toThrow(
      "spawn ENOENT",
    );
  });
});
