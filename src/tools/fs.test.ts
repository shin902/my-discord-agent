import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  readdir: vi.fn(),
  glob: vi.fn(),
  stat: vi.fn(),
}));

import {
  glob,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  editTool,
  globTool,
  grepTool,
  listTool,
  readTool,
  writeTool,
} from "./fs.js";

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

  it("長い内容も省略せずそのまま返す", async () => {
    const big = "a".repeat(9000);
    vi.mocked(readFile).mockResolvedValue(big as never);
    const result = await readTool.execute("call-1", { path: "long.txt" });
    expect(firstText(result)).toBe(big);
  });

  it("パストラバーサルを拒否", async () => {
    await expect(
      readTool.execute("call-1", { path: "../etc/passwd" }),
    ).rejects.toThrow("アクセス拒否");
  });

  it("/workspace プレフィックス + トラバーサルも拒否", async () => {
    await expect(
      readTool.execute("call-1", { path: "/workspace/../../etc/passwd" }),
    ).rejects.toThrow("アクセス拒否");
  });

  it("/workspace 始まりの絶対パスも相対パスと同様に解決する", async () => {
    vi.mocked(readFile).mockResolvedValue("hello world" as never);
    const result = await readTool.execute("call-1", {
      path: "/workspace/test.txt",
    });
    expect(firstText(result)).toBe("hello world");
    expect(readFile).toHaveBeenCalledWith("/workspace/test.txt", "utf-8");
  });

  it("/workspace 以外の絶対パスはコンテナ内の実パスとしてそのまま読む（追加マウント対応）", async () => {
    vi.mocked(readFile).mockResolvedValue("hello world" as never);
    const result = await readTool.execute("call-1", {
      path: "/obsidian/wiki/index.md",
    });
    expect(firstText(result)).toBe("hello world");
    expect(readFile).toHaveBeenCalledWith("/obsidian/wiki/index.md", "utf-8");
  });

  it("画像ファイルは base64 の image content を返す", async () => {
    vi.mocked(stat).mockResolvedValue({ size: 1234 } as never);
    vi.mocked(readFile).mockResolvedValue("base64data" as never);

    const result = await readTool.execute("call-1", { path: "photo.png" });

    expect(readFile).toHaveBeenCalledWith("/workspace/photo.png", "base64");
    expect(result.content[0]).toEqual({
      type: "image",
      data: "base64data",
      mimeType: "image/png",
    });
  });

  it("拡張子に応じて mimeType を判定する (jpg/jpeg/gif/webp)", async () => {
    vi.mocked(stat).mockResolvedValue({ size: 100 } as never);
    vi.mocked(readFile).mockResolvedValue("data" as never);

    const cases: Array<[string, string]> = [
      ["a.jpg", "image/jpeg"],
      ["a.jpeg", "image/jpeg"],
      ["a.gif", "image/gif"],
      ["a.webp", "image/webp"],
    ];
    for (const [path, mimeType] of cases) {
      const result = await readTool.execute("call-1", { path });
      expect(result.content[0]).toMatchObject({ type: "image", mimeType });
    }
  });

  it("画像が10MBを超える場合はエラーになる", async () => {
    vi.mocked(stat).mockResolvedValue({ size: 11 * 1024 * 1024 } as never);

    await expect(
      readTool.execute("call-1", { path: "huge.png" }),
    ).rejects.toThrow("画像が大きすぎます");
    expect(readFile).not.toHaveBeenCalled();
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

  it("/workspace 以外の絶対パスはコンテナ内の実パスとしてそのまま書き込む（追加マウント対応）", async () => {
    await writeTool.execute("call-1", {
      path: "/obsidian/wiki/index.md",
      content: "hello",
    });
    expect(writeFile).toHaveBeenCalledWith(
      "/obsidian/wiki/index.md",
      "hello",
      "utf-8",
    );
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

  it("/workspace 以外の絶対パスはコンテナ内の実パスをそのまま一覧する（追加マウント対応）", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: "index.md", isDirectory: () => false, isFile: () => true },
    ] as never);
    const result = await listTool.execute("call-1", {
      path: "/obsidian/wiki",
    });
    expect(readdir).toHaveBeenCalledWith("/obsidian/wiki", {
      withFileTypes: true,
    });
    expect(firstText(result)).toContain("file: index.md");
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

  it("/workspace 以外の絶対パスはコンテナ内の実パスをそのまま編集する（追加マウント対応）", async () => {
    vi.mocked(readFile).mockResolvedValue("hello world" as never);
    await editTool.execute("call-1", {
      path: "/obsidian/wiki/index.md",
      oldString: "world",
      newString: "sandbox",
    });
    expect(readFile).toHaveBeenCalledWith("/obsidian/wiki/index.md", "utf-8");
    expect(writeFile).toHaveBeenCalledWith(
      "/obsidian/wiki/index.md",
      "hello sandbox",
      "utf-8",
    );
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

  it("/workspace 以外の絶対パスはコンテナ内の実パスをそのまま検索する（追加マウント対応）", async () => {
    async function* mockGlob() {
      yield "index.md";
    }
    vi.mocked(glob).mockReturnValue(mockGlob() as never);
    const result = await globTool.execute("call-1", {
      pattern: "*.md",
      path: "/obsidian/wiki",
    });
    expect(glob).toHaveBeenCalledWith("*.md", {
      cwd: "/obsidian/wiki",
      withFileTypes: false,
    });
    expect(firstText(result)).toContain("/obsidian/wiki/index.md");
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

  it("/workspace 以外の絶対パスはコンテナ内の実パスをそのまま検索する（追加マウント対応）", async () => {
    vi.mocked(stat).mockResolvedValue({ isFile: () => true } as never);
    vi.mocked(readFile).mockResolvedValue("hello world" as never);
    const result = await grepTool.execute("call-1", {
      pattern: "hello",
      path: "/obsidian/wiki/index.md",
    });
    expect(stat).toHaveBeenCalledWith("/obsidian/wiki/index.md");
    expect(readFile).toHaveBeenCalledWith("/obsidian/wiki/index.md", "utf-8");
    expect(firstText(result)).toContain(
      "/obsidian/wiki/index.md:1: hello world",
    );
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
