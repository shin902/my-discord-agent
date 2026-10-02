import { beforeEach, expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async (...args: unknown[]) => {
        const result = run(...args);
        if (result.error) throw result.error;
        return {
          stdout: result.stdout ?? Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        };
      },
    }),
  };
});

import { readTool } from "./fs.js";

beforeEach(() => run.mockReset());

it("uses bounded, shell-free single-page rendering with the tool signal", async () => {
  const stdout = Buffer.from("image");
  run.mockReturnValue({ stdout });
  const signal = new AbortController().signal;
  await readTool.execute(
    "pdf",
    { path: "/workspace/a ; $(touch bad).PDF", page: 2 },
    signal,
  );
  expect(run).toHaveBeenCalledExactlyOnceWith(
    "pdftoppm",
    [
      "-f",
      "2",
      "-l",
      "2",
      "-singlefile",
      "-scale-to",
      "2048",
      "-png",
      "/workspace/a ; $(touch bad).PDF",
    ],
    {
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      killSignal: "SIGKILL",
      signal,
    },
  );
});

it.each([
  [{ code: "ENOENT" }, "Runner image を再ビルド"],
  [{ killed: true }, "処理時間または出力サイズの上限"],
  [
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    "処理時間または出力サイズの上限",
  ],
])("reports renderer failures: %j", async (properties, message) => {
  run.mockReturnValue({
    error: Object.assign(new Error("failed"), properties),
  });
  await expect(
    readTool.execute("pdf", { path: "file.pdf", page: 1 }),
  ).rejects.toThrow(message);
});

it("rejects an empty renderer result", async () => {
  run.mockReturnValue({ stdout: Buffer.alloc(0) });
  await expect(
    readTool.execute("pdf", { path: "file.pdf", page: 1 }),
  ).rejects.toThrow("画像が生成されませんでした");
});
