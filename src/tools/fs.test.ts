import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FsDependencies } from "./fs.js";
import { createFsTool } from "./fs.js";

const fakeFs = {
  createReadStream: vi.fn<FsDependencies["createReadStream"]>(),
  glob: vi.fn<FsDependencies["glob"]>(),
  mkdir: vi.fn<FsDependencies["mkdir"]>(),
  readdir: vi.fn<FsDependencies["readdir"]>(),
  readFile: vi.fn<FsDependencies["readFile"]>(),
  stat: vi.fn<FsDependencies["stat"]>(),
  writeFile: vi.fn<FsDependencies["writeFile"]>(),
} satisfies FsDependencies;

const { readTool, writeTool, editTool, globTool, grepTool, listTool } =
  createFsTool(fakeFs);

beforeEach(() => {
  vi.clearAllMocks();
  fakeFs.mkdir.mockResolvedValue(undefined);
  fakeFs.writeFile.mockResolvedValue(undefined);
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

function mockReadStream(...chunks: string[]): void {
  async function* stream() {
    yield* chunks;
  }
  fakeFs.createReadStream.mockReturnValue(stream());
}

function mockGeneratedReadStream(lineCount: number): void {
  async function* stream() {
    for (let line = 1; line <= lineCount; line += 1) {
      yield `line ${line}\n`;
    }
  }
  fakeFs.createReadStream.mockReturnValue(stream());
}

function generatedReadSize(lineCount: number): number {
  let size = 0;
  for (let line = 1; line <= lineCount; line += 1) {
    size += `line ${line}\n`.length;
  }
  return size;
}

describe("read", () => {
  it("ファイル内容を読み込む", async () => {
    fakeFs.readFile.mockResolvedValue("hello world");
    const result = await readTool.execute("call-1", { path: "test.txt" });
    expect(firstText(result)).toBe("hello world");
    expect(fakeFs.readFile).toHaveBeenCalledWith(
      "/workspace/test.txt",
      "utf-8",
    );
  });

  it("長い内容も省略せずそのまま返す", async () => {
    const big = "a".repeat(50_001);
    fakeFs.readFile.mockResolvedValue(big);
    const result = await readTool.execute("call-1", { path: "long.txt" });
    expect(firstText(result)).toBe(big);
  });

  it("lineCount だけなら先頭から指定行数を返す", async () => {
    const raw = "line 1\nline 2\nline 3\nline 4";
    mockReadStream(raw);

    const result = await readTool.execute("call-1", {
      path: "notes.txt",
      lineCount: 2,
    });

    expect(firstText(result)).toBe("line 1\nline 2");
    expect(result.details).toMatchObject({
      path: "notes.txt",
      characters: raw.length,
      returnedCharacters: "line 1\nline 2".length,
      startLine: 1,
      endLine: 2,
      returnedLineCount: 2,
      totalLines: 4,
      eof: false,
    });
  });

  it("startLine だけなら指定行から EOF までを返す", async () => {
    mockReadStream("line 1\nline 2\nline 3\nline 4");

    const result = await readTool.execute("call-1", {
      path: "notes.txt",
      startLine: 3,
    });

    expect(firstText(result)).toBe("line 3\nline 4");
    expect(result.details).toMatchObject({
      characters: "line 1\nline 2\nline 3\nline 4".length,
      returnedCharacters: "line 3\nline 4".length,
      startLine: 3,
      endLine: 4,
      returnedLineCount: 2,
      totalLines: 4,
      eof: true,
    });
  });

  it("大きな改行密集ストリームでも先頭の要求行だけを保持する", async () => {
    const totalLines = 20_000;
    mockGeneratedReadStream(totalLines);

    const result = await readTool.execute("call-1", {
      path: "large.txt",
      lineCount: 3,
    });

    expect(firstText(result)).toBe("line 1\nline 2\nline 3");
    expect(fakeFs.readFile).not.toHaveBeenCalled();
    expect(fakeFs.createReadStream).toHaveBeenCalledWith(
      "/workspace/large.txt",
      {
        encoding: "utf8",
      },
    );
    expect(result.details).toMatchObject({
      size: generatedReadSize(totalLines),
      totalLines,
      startLine: 1,
      endLine: 3,
      returnedLineCount: 3,
      eof: false,
    });
  });

  it("大きな改行密集ストリームでも中間の限定範囲だけを保持する", async () => {
    const totalLines = 20_000;
    const startLine = 12_345;
    mockGeneratedReadStream(totalLines);

    const result = await readTool.execute("call-1", {
      path: "large.txt",
      startLine,
      lineCount: 2,
    });

    expect(firstText(result)).toBe("line 12345\nline 12346");
    expect(fakeFs.readFile).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      size: generatedReadSize(totalLines),
      totalLines,
      startLine,
      endLine: startLine + 1,
      returnedLineCount: 2,
      eof: false,
    });
  });

  it("startLine と lineCount で範囲を指定する", async () => {
    mockReadStream("line 1\nline 2\nline 3\nline 4");

    const result = await readTool.execute("call-1", {
      path: "notes.txt",
      startLine: 2,
      lineCount: 2,
    });

    expect(firstText(result)).toBe("line 2\nline 3");
    expect(result.details).toMatchObject({
      startLine: 2,
      endLine: 3,
      returnedLineCount: 2,
      totalLines: 4,
      eof: false,
    });
  });

  it("tailCount なら末尾から指定行数を返す", async () => {
    mockReadStream("line 1\nline 2\nline 3\nline 4");

    const result = await readTool.execute("call-1", {
      path: "notes.txt",
      tailCount: 2,
    });

    expect(firstText(result)).toBe("line 3\nline 4");
    expect(result.details).toMatchObject({
      startLine: 3,
      endLine: 4,
      returnedLineCount: 2,
      totalLines: 4,
      eof: true,
    });
  });

  it("大きな改行密集ストリームでも末尾の要求行だけを保持する", async () => {
    const totalLines = 20_000;
    mockGeneratedReadStream(totalLines);

    const result = await readTool.execute("call-1", {
      path: "large.txt",
      tailCount: 3,
    });

    expect(firstText(result)).toBe("line 19998\nline 19999\nline 20000");
    expect(fakeFs.readFile).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      size: generatedReadSize(totalLines),
      totalLines,
      startLine: totalLines - 2,
      endLine: totalLines,
      returnedLineCount: 3,
      eof: true,
    });
  });

  it("tailCount は startLine/lineCount と併用できない", async () => {
    fakeFs.readFile.mockResolvedValue("line 1\nline 2");

    await expect(
      readTool.execute("call-1", {
        path: "notes.txt",
        startLine: 1,
        tailCount: 1,
      }),
    ).rejects.toThrow("tailCount");
    await expect(
      readTool.execute("call-1", {
        path: "notes.txt",
        lineCount: 1,
        tailCount: 1,
      }),
    ).rejects.toThrow("tailCount");
    expect(fakeFs.readFile).not.toHaveBeenCalled();
  });

  it("行範囲の値は正の整数でなければならない", async () => {
    const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const field of ["startLine", "lineCount", "tailCount"] as const) {
      for (const value of invalidValues) {
        await expect(
          readTool.execute("call-1", {
            path: "notes.txt",
            [field]: value,
          }),
        ).rejects.toThrow(`${field} は正の整数`);
      }
    }
    expect(fakeFs.readFile).not.toHaveBeenCalled();
  });

  it("startLine が EOF を超える場合は明示的にエラーになる", async () => {
    mockReadStream("line 1\nline 2");

    await expect(
      readTool.execute("call-1", { path: "notes.txt", startLine: 3 }),
    ).rejects.toThrow("startLine 3 は EOF を超えています");
  });

  it("空ファイルは0行として扱う", async () => {
    mockReadStream("");

    const result = await readTool.execute("call-1", {
      path: "empty.txt",
      lineCount: 10,
    });

    expect(firstText(result)).toBe("");
    expect(result.details).toMatchObject({
      startLine: 0,
      endLine: 0,
      returnedLineCount: 0,
      totalLines: 0,
      eof: true,
    });
  });

  it("空行を数え、末尾の改行を余分な行として数えない", async () => {
    const raw = "line 1\n\nline 3\n";
    mockReadStream(raw);

    const result = await readTool.execute("call-1", {
      path: "notes.txt",
      lineCount: 10,
    });

    expect(firstText(result)).toBe("line 1\n\nline 3");
    expect(result.details).toMatchObject({
      startLine: 1,
      endLine: 3,
      returnedLineCount: 3,
      totalLines: 3,
      eof: true,
    });
  });

  it("行範囲でも Unicode をそのまま返す", async () => {
    mockReadStream("日本語\n😀 café\n終わり");
    const result = await readTool.execute("call-1", {
      path: "unicode.txt",
      startLine: 2,
      lineCount: 1,
    });

    expect(firstText(result)).toBe("😀 café");
    expect(result.details).toMatchObject({
      startLine: 2,
      endLine: 2,
      returnedLineCount: 1,
      totalLines: 3,
      eof: false,
    });
  });

  it("画像の行範囲指定は拒否する", async () => {
    await expect(
      readTool.execute("call-1", {
        path: "photo.png",
        startLine: 1,
        lineCount: 1,
      }),
    ).rejects.toThrow("画像ファイルでは行範囲を指定できません");
    expect(fakeFs.stat).not.toHaveBeenCalled();
    expect(fakeFs.readFile).not.toHaveBeenCalled();
  });

  it("read の説明に行範囲と順次読み込みの指示が含まれる", () => {
    expect(readTool.description).toContain("startLine");
    expect(readTool.description).toContain("lineCount");
    expect(readTool.description).toContain("tailCount");
    expect(readTool.description).toContain("順番");
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
    fakeFs.readFile.mockResolvedValue("hello world");
    const result = await readTool.execute("call-1", {
      path: "/workspace/test.txt",
    });
    expect(firstText(result)).toBe("hello world");
    expect(fakeFs.readFile).toHaveBeenCalledWith(
      "/workspace/test.txt",
      "utf-8",
    );
  });

  it("/workspace 以外の絶対パスはコンテナ内の実パスとしてそのまま読む（追加マウント対応）", async () => {
    fakeFs.readFile.mockResolvedValue("hello world");
    const result = await readTool.execute("call-1", {
      path: "/obsidian/wiki/index.md",
    });
    expect(firstText(result)).toBe("hello world");
    expect(fakeFs.readFile).toHaveBeenCalledWith(
      "/obsidian/wiki/index.md",
      "utf-8",
    );
  });

  it("画像ファイルは base64 の image content を返す", async () => {
    fakeFs.stat.mockResolvedValue({ size: 1234 });
    fakeFs.readFile.mockResolvedValue("base64data");

    const result = await readTool.execute("call-1", { path: "photo.png" });

    expect(fakeFs.readFile).toHaveBeenCalledWith(
      "/workspace/photo.png",
      "base64",
    );
    expect(result.content[0]).toEqual({
      type: "image",
      data: "base64data",
      mimeType: "image/png",
    });
  });

  it("拡張子に応じて mimeType を判定する (jpg/jpeg/gif/webp)", async () => {
    fakeFs.stat.mockResolvedValue({ size: 100 });
    fakeFs.readFile.mockResolvedValue("data");

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
    fakeFs.stat.mockResolvedValue({ size: 11 * 1024 * 1024 });

    await expect(
      readTool.execute("call-1", { path: "huge.png" }),
    ).rejects.toThrow("画像が大きすぎます");
    expect(fakeFs.readFile).not.toHaveBeenCalled();
  });
});

describe("write", () => {
  it("ファイルを書き込む", async () => {
    const result = await writeTool.execute("call-1", {
      path: "out.txt",
      content: "hello",
    });
    expect(firstText(result)).toBe("書き込み完了: out.txt (5 文字, 1 行)");
    expect(fakeFs.writeFile).toHaveBeenCalledWith(
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
    expect(fakeFs.mkdir).toHaveBeenCalledWith("/workspace/sub/dir", {
      recursive: true,
    });
  });

  it("/workspace 以外の絶対パスはコンテナ内の実パスとしてそのまま書き込む（追加マウント対応）", async () => {
    await writeTool.execute("call-1", {
      path: "/obsidian/wiki/index.md",
      content: "hello",
    });
    expect(fakeFs.writeFile).toHaveBeenCalledWith(
      "/obsidian/wiki/index.md",
      "hello",
      "utf-8",
    );
  });
});

describe("list", () => {
  it("エントリ一覧を返す", async () => {
    fakeFs.readdir.mockResolvedValue([
      { name: "foo.txt", isDirectory: () => false, isFile: () => true },
      { name: "bar", isDirectory: () => true, isFile: () => false },
    ]);
    const result = await listTool.execute("call-1", { path: "" });
    expect(firstText(result)).toContain("file: foo.txt");
    expect(firstText(result)).toContain("dir: bar");
    expect(fakeFs.readdir).toHaveBeenCalledWith("/workspace", {
      withFileTypes: true,
    });
  });

  it("空ディレクトリ", async () => {
    fakeFs.readdir.mockResolvedValue([]);
    const result = await listTool.execute("call-1", { path: "" });
    expect(firstText(result)).toBe("(空のディレクトリ)");
  });

  it("/workspace 以外の絶対パスはコンテナ内の実パスをそのまま一覧する（追加マウント対応）", async () => {
    fakeFs.readdir.mockResolvedValue([
      { name: "index.md", isDirectory: () => false, isFile: () => true },
    ]);
    const result = await listTool.execute("call-1", {
      path: "/obsidian/wiki",
    });
    expect(fakeFs.readdir).toHaveBeenCalledWith("/obsidian/wiki", {
      withFileTypes: true,
    });
    expect(firstText(result)).toContain("file: index.md");
  });
});

describe("edit", () => {
  it("部分置換する", async () => {
    fakeFs.readFile.mockResolvedValue("hello world");
    const result = await editTool.execute("call-1", {
      path: "test.txt",
      oldString: "world",
      newString: "sandbox",
    });
    expect(fakeFs.writeFile).toHaveBeenCalledWith(
      "/workspace/test.txt",
      "hello sandbox",
      "utf-8",
    );
    expect(firstText(result)).toBe(
      "編集完了: test.txt (1 箇所置換, 13 文字, 1 行)",
    );
  });

  it("置換対象がないとエラー", async () => {
    fakeFs.readFile.mockResolvedValue("hello world");
    await expect(
      editTool.execute("call-1", {
        path: "test.txt",
        oldString: "missing",
        newString: "x",
      }),
    ).rejects.toThrow("置換対象が見つかりません");
  });

  it("/workspace 以外の絶対パスはコンテナ内の実パスをそのまま編集する（追加マウント対応）", async () => {
    fakeFs.readFile.mockResolvedValue("hello world");
    await editTool.execute("call-1", {
      path: "/obsidian/wiki/index.md",
      oldString: "world",
      newString: "sandbox",
    });
    expect(fakeFs.readFile).toHaveBeenCalledWith(
      "/obsidian/wiki/index.md",
      "utf-8",
    );
    expect(fakeFs.writeFile).toHaveBeenCalledWith(
      "/obsidian/wiki/index.md",
      "hello sandbox",
      "utf-8",
    );
  });

  it("oldString が空文字列の場合はエラー", async () => {
    fakeFs.readFile.mockResolvedValue("hello world");
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
    fakeFs.glob.mockReturnValue(mockGlob());
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
    fakeFs.glob.mockReturnValue(mockGlob());
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
    fakeFs.glob.mockReturnValue(mockGlob());
    const result = await globTool.execute("call-1", {
      pattern: "*.md",
      path: "/obsidian/wiki",
    });
    expect(fakeFs.glob).toHaveBeenCalledWith("*.md", {
      cwd: "/obsidian/wiki",
      withFileTypes: false,
    });
    expect(firstText(result)).toContain("/obsidian/wiki/index.md");
  });
});

describe("grep", () => {
  it("正規表現でファイル内容を検索する", async () => {
    fakeFs.stat.mockResolvedValue({ isFile: () => true });
    fakeFs.readFile.mockResolvedValue("hello world\nfoo bar\nhello sandbox");
    const result = await grepTool.execute("call-1", {
      pattern: "hello",
      path: "test.txt",
    });
    expect(firstText(result)).toContain("test.txt:1: hello world");
    expect(firstText(result)).toContain("test.txt:3: hello sandbox");
  });

  it("/workspace 以外の絶対パスはコンテナ内の実パスをそのまま検索する（追加マウント対応）", async () => {
    fakeFs.stat.mockResolvedValue({ isFile: () => true });
    fakeFs.readFile.mockResolvedValue("hello world");
    const result = await grepTool.execute("call-1", {
      pattern: "hello",
      path: "/obsidian/wiki/index.md",
    });
    expect(fakeFs.stat).toHaveBeenCalledWith("/obsidian/wiki/index.md");
    expect(fakeFs.readFile).toHaveBeenCalledWith(
      "/obsidian/wiki/index.md",
      "utf-8",
    );
    expect(firstText(result)).toContain(
      "/obsidian/wiki/index.md:1: hello world",
    );
  });

  it("ディレクトリを再帰検索する", async () => {
    fakeFs.stat.mockResolvedValue({
      isFile: () => false,
      isDirectory: () => true,
    });
    async function* mockGlob() {
      yield "a.txt";
    }
    fakeFs.glob.mockReturnValue(mockGlob());
    fakeFs.readFile.mockResolvedValue("hello world");
    const result = await grepTool.execute("call-1", {
      pattern: "hello",
      path: "src",
    });
    expect(firstText(result)).toContain("src/a.txt:1: hello world");
  });

  it("一致なし", async () => {
    fakeFs.stat.mockResolvedValue({ isFile: () => true });
    fakeFs.readFile.mockResolvedValue("foo bar");
    const result = await grepTool.execute("call-1", {
      pattern: "baz",
      path: "test.txt",
    });
    expect(firstText(result)).toBe("(一致なし)");
  });

  it("存在しないパスは (一致なし) を返す", async () => {
    fakeFs.stat.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const result = await grepTool.execute("call-1", {
      pattern: "hello",
      path: "nonexistent.txt",
    });
    expect(firstText(result)).toBe("(一致なし)");
  });

  it("ENOENT 以外の stat エラーは再スロー", async () => {
    fakeFs.stat.mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );
    await expect(
      grepTool.execute("call-1", { pattern: "hello", path: "secret.txt" }),
    ).rejects.toThrow("EACCES");
  });
});
