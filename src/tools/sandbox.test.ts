import { beforeEach, describe, expect, it, vi } from "vitest";

let mockExec = vi.fn();

vi.mock("microsandbox", () => ({
  Sandbox: {
    builder: vi.fn(() => {
      const chain = {
        image: vi.fn(() => chain),
        cpus: vi.fn(() => chain),
        memory: vi.fn(() => chain),
        create: vi.fn(async () => ({
          exec: (...args: unknown[]) => mockExec(...args),
          [Symbol.asyncDispose]: vi.fn(),
        })),
      };
      return chain;
    }),
  },
}));

import { Sandbox } from "microsandbox";
import { sandboxTool } from "./sandbox.js";

beforeEach(() => {
  vi.clearAllMocks();
  mockExec = vi.fn();
});

function makeResult(stdout: string, stderr: string, code: number) {
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    code,
  };
}

describe("sandboxTool", () => {
  it("コードを実行して stdout を返す", async () => {
    mockExec.mockResolvedValue(makeResult("hello", "", 0));

    const result = await sandboxTool.execute("call-1", { code: "console.log('hello')" });

    expect(mockExec).toHaveBeenCalledWith("node", ["-e", "console.log('hello')"]);
    expect(result.content).toEqual([{ type: "text", text: "stdout:\nhello" }]);
    expect(result.details).toEqual({ exitCode: 0 });
  });

  it("stdout と stderr の両方を返す", async () => {
    mockExec.mockResolvedValue(makeResult("out", "err", 1));

    const result = await sandboxTool.execute("call-1", { code: "x" });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toContain("stdout:\nout");
    expect(text).toContain("stderr:\nerr");
    expect(result.details).toEqual({ exitCode: 1 });
  });

  it("出力がない場合は (出力なし) を返す", async () => {
    mockExec.mockResolvedValue(makeResult("", "", 0));

    const result = await sandboxTool.execute("call-1", { code: "1+1" });

    expect(result.content).toEqual([{ type: "text", text: "(出力なし)" }]);
  });

  it("長い出力は 4000 文字で切り詰める", async () => {
    const long = "a".repeat(5000);
    mockExec.mockResolvedValue(makeResult(long, "", 0));

    const result = await sandboxTool.execute("call-1", { code: "x" });

    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toHaveLength(4000 + "stdout:\n".length);
  });

  it("exec が失敗した場合はエラーを投げる", async () => {
    mockExec.mockRejectedValue(new Error("sandbox crashed"));

    await expect(sandboxTool.execute("call-1", { code: "throw 1" })).rejects.toThrow(
      "sandbox crashed",
    );
  });

  it("タイムアウトした場合はエラーを投げる", async () => {
    vi.useFakeTimers();
    mockExec.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 60_000)),
    );

    const promise = sandboxTool.execute("call-1", { code: "while(true) {}" });
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(31_000);

    await expect(promise).rejects.toThrow("実行タイムアウト");
    vi.useRealTimers();
  });

  it("Sandbox.builder にタイムスタンプ付き名前が渡される", async () => {
    mockExec.mockResolvedValue(makeResult("", "", 0));
    const before = Date.now();

    await sandboxTool.execute("call-1", { code: "1" });

    const after = Date.now();
    const nameArg = vi.mocked(Sandbox.builder).mock.calls[0][0];
    expect(nameArg).toMatch(/^agent-sandbox-\d+$/);
    const timestamp = Number(nameArg.replace("agent-sandbox-", ""));
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});
