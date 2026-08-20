import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBashTool } from "./bash.js";

type ExecResult = { stdout: string; stderr: string };
type ExecFn = (command: string, options: { timeout: number; maxBuffer: number; cwd: string }) => Promise<ExecResult>;

function getText(result: Awaited<ReturnType<ReturnType<typeof createBashTool>["execute"]>>): string {
  const c = result.content[0];
  if (c.type !== "text") throw new Error("expected text content");
  return c.text;
}

beforeEach(() => vi.clearAllMocks());

describe("bashTool", () => {
  it("コマンドの stdout を返す", async () => {
    const exec: ExecFn = vi.fn().mockResolvedValue({ stdout: "hello\n", stderr: "" });
    const result = await createBashTool(exec).execute("id", { command: "echo hello" }, undefined, undefined);
    expect(getText(result)).toBe("hello");
  });

  it("stderr もキャプチャして返す", async () => {
    const exec: ExecFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "warn\n" });
    const result = await createBashTool(exec).execute("id", { command: "echo warn >&2" }, undefined, undefined);
    expect(getText(result)).toContain("warn");
  });

  it("コマンド失敗時はエラーをスローする", async () => {
    const exec: ExecFn = vi.fn().mockRejectedValue(Object.assign(new Error("failed"), { stderr: "error output\n" }));
    await expect(createBashTool(exec).execute("id", { command: "exit 1" }, undefined, undefined)).rejects.toThrow("error output");
  });

  it("出力なしのコマンドは (出力なし) を返す", async () => {
    const exec: ExecFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const result = await createBashTool(exec).execute("id", { command: "true" }, undefined, undefined);
    expect(getText(result)).toBe("(出力なし)");
  });

  it("大きな出力は省略せずそのまま返す", async () => {
    const big = "a".repeat(15_000);
    const exec: ExecFn = vi.fn().mockResolvedValue({ stdout: big, stderr: "" });
    const result = await createBashTool(exec).execute("id", { command: "cat big" }, undefined, undefined);
    expect(getText(result)).toBe(big);
  });
});
