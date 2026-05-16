import type { ChildProcess } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

import { exec } from "node:child_process";
import { bashTool } from "./bash.js";

const mockExec = vi.mocked(exec);

function mockSuccess(stdout: string, stderr = "") {
  mockExec.mockImplementation((_cmd, _opts, cb) => {
    cb?.(null, stdout, stderr);
    return {} as ChildProcess;
  });
}

function mockFailure(err: Error) {
  mockExec.mockImplementation((_cmd, _opts, cb) => {
    cb?.(
      err,
      "",
      (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "",
    );
    return {} as ChildProcess;
  });
}

function getText(result: Awaited<ReturnType<typeof bashTool.execute>>): string {
  const c = result.content[0];
  if (c.type !== "text") throw new Error("expected text content");
  return c.text;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bashTool", () => {
  it("コマンドの stdout を返す", async () => {
    mockSuccess("hello\n");
    const result = await bashTool.execute(
      "id",
      { command: "echo hello" },
      undefined,
      undefined,
    );
    expect(getText(result)).toBe("hello");
  });

  it("stderr もキャプチャして返す", async () => {
    mockSuccess("", "warn\n");
    const result = await bashTool.execute(
      "id",
      { command: "echo warn >&2" },
      undefined,
      undefined,
    );
    expect(getText(result)).toContain("warn");
  });

  it("コマンド失敗時はエラーをスローする", async () => {
    const err = Object.assign(new Error("failed"), {
      stderr: "error output\n",
    });
    mockFailure(err);
    await expect(
      bashTool.execute("id", { command: "exit 1" }, undefined, undefined),
    ).rejects.toThrow("error output");
  });

  it("出力なしのコマンドは (出力なし) を返す", async () => {
    mockSuccess("", "");
    const result = await bashTool.execute(
      "id",
      { command: "true" },
      undefined,
      undefined,
    );
    expect(getText(result)).toBe("(出力なし)");
  });

  it("大きな出力は省略せずそのまま返す", async () => {
    const big = "a".repeat(15_000);
    mockSuccess(big);
    const result = await bashTool.execute(
      "id",
      { command: "cat big" },
      undefined,
      undefined,
    );
    expect(getText(result)).toBe(big);
  });
});
