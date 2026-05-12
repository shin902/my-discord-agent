import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  glob: vi.fn(),
  stat: vi.fn(),
}));

import { glob, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { editTool, globTool, grepTool, listTool, readTool, writeTool } from "./fs.js";

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

  it("oldString が空文字列の場合はエラー", async () => {
    vi.mocked(readFile).mockResolvedValue("hello world" as never);
    await expect(
      editTool.execute("call-1", {
        path: "test.txt",
        oldString: "",
        newString: "x",
      }),
    ).rejects.toThrow(
      "置換対象の文字列（oldString）を空にすることはできません",
    );
  });
});

describe("glob", () => {
  it("glob パターンでファイルを検索する", async () => {
    async function* mockGlob() {
      yield "foo.ts";
      yield "bar.ts";
    }
    vi.mocked(glob).mockReturnValue(mockGlob() as never);
    const result = await globTool.execute("call-1", {
      pattern: "*.ts",
      path: "",
    });
    expect(firstText(result)).toContain("foo.ts");
    expect(firstText(result)).toContain("bar.ts");
  });

  it("一致なし", async () => {
    async function* mockGlob() {
      yield* [];
    }
    vi.mocked(glob).mockReturnValue(mockGlob() as never);
    const result = await globTool.execute("call-1", {
      pattern: "*.md",
      path: "",
    });
    expect(firstText(result)).toBe("(一致なし)");
  });
});

describe("grep", () => {
  it("正規表現でファイル内容を検索する", async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(readFile).mockResolvedValue(
      "hello world\nfoo bar\nhello sandbox" as never,
    );
    const result = await grepTool.execute("call-1", {
      pattern: "hello",
      path: "test.txt",
    });
    expect(firstText(result)).toContain("test.txt:1: hello world");
    expect(firstText(result)).toContain("test.txt:3: hello sandbox");
  });

  it("ディレクトリを再帰検索する", async () => {
    vi.mocked(stat).mockResolvedValue({
      isFile: () => false,
      isDirectory: () => true,
    } as never);
    async function* mockGlob() {
      yield "a.txt";
    }
    vi.mocked(glob).mockReturnValue(mockGlob() as never);
    vi.mocked(readFile).mockResolvedValue("hello world" as never);
    const result = await grepTool.execute("call-1", {
      pattern: "hello",
      path: "src",
    });
    expect(firstText(result)).toContain("src/a.txt:1: hello world");
  });

  it("一致なし", async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(readFile).mockResolvedValue("foo bar" as never);
    const result = await grepTool.execute("call-1", {
      pattern: "baz",
      path: "test.txt",
    });
    expect(firstText(result)).toBe("(一致なし)");
  });

  it("存在しないパスは (一致なし) を返す", async () => {
    vi.mocked(stat).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const result = await grepTool.execute("call-1", {
      pattern: "hello",
      path: "nonexistent.txt",
    });
    expect(firstText(result)).toBe("(一致なし)");
  });

  it("ENOENT 以外の stat エラーは再スロー", async () => {
    vi.mocked(stat).mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );
    await expect(
      grepTool.execute("call-1", { pattern: "hello", path: "secret.txt" }),
    ).rejects.toThrow("EACCES");
  });
});
