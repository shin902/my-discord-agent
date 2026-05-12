import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
}));

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { editTool, listTool, readTool, writeTool } from "./fs.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mkdir).mockResolvedValue(undefined);
  vi.mocked(writeFile).mockResolvedValue(undefined);
});

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text == null) {
    throw new Error("Expected text content");
  }
  return first.text;
}

describe("read", () => {
  it("ファイル内容を読み込む", async () => {
    vi.mocked(readFile).mockResolvedValue("hello world" as never);
    const result = await readTool.execute("call-1", { path: "test.txt" });
    expect(firstText(result)).toBe("hello world");
    expect(readFile).toHaveBeenCalledWith("/workspace/test.txt", "utf-8");
  });

  it("長い内容は省略する", async () => {
    vi.mocked(readFile).mockResolvedValue("a".repeat(9000) as never);
    const result = await readTool.execute("call-1", { path: "long.txt" });
    expect(firstText(result)).toContain("... (省略");
  });

  it("パストラバーサルを拒否", async () => {
    await expect(
      readTool.execute("call-1", { path: "../etc/passwd" }),
    ).rejects.toThrow("アクセス拒否");
  });
});

describe("write", () => {
  it("ファイルを書き込む", async () => {
    const result = await writeTool.execute("call-1", {
      path: "out.txt",
      content: "hello",
    });
    expect(firstText(result)).toBe("書き込み完了: out.txt");
    expect(writeFile).toHaveBeenCalledWith(
      "/workspace/out.txt",
      "hello",
      "utf-8",
    );
  });

  it("サブディレクトリを自動作成する", async () => {
    await writeTool.execute("call-1", {
      path: "sub/dir/file.txt",
      content: "x",
    });
    expect(mkdir).toHaveBeenCalledWith("/workspace/sub/dir", {
      recursive: true,
    });
  });
});

describe("list", () => {
  it("エントリ一覧を返す", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: "foo.txt", isDirectory: () => false, isFile: () => true },
      { name: "bar", isDirectory: () => true, isFile: () => false },
    ] as never);
    const result = await listTool.execute("call-1", { path: "" });
    expect(firstText(result)).toContain("file: foo.txt");
    expect(firstText(result)).toContain("dir: bar");
    expect(readdir).toHaveBeenCalledWith("/workspace", { withFileTypes: true });
  });

  it("空ディレクトリ", async () => {
    vi.mocked(readdir).mockResolvedValue([] as never);
    const result = await listTool.execute("call-1", { path: "" });
    expect(firstText(result)).toBe("(空のディレクトリ)");
  });
});

describe("edit", () => {
  it("部分置換する", async () => {
    vi.mocked(readFile).mockResolvedValue("hello world" as never);
    const result = await editTool.execute("call-1", {
      path: "test.txt",
      oldString: "world",
      newString: "sandbox",
    });
    expect(writeFile).toHaveBeenCalledWith(
      "/workspace/test.txt",
      "hello sandbox",
      "utf-8",
    );
    expect(firstText(result)).toBe("編集完了: test.txt (1 箇所置換)");
  });

  it("置換対象がないとエラー", async () => {
    vi.mocked(readFile).mockResolvedValue("hello world" as never);
    await expect(
      editTool.execute("call-1", {
        path: "test.txt",
        oldString: "missing",
        newString: "x",
      }),
    ).rejects.toThrow("置換対象が見つかりません");
  });
});
