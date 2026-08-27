import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  link: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  appendFile: vi.fn(),
  mkdir: vi.fn(),
  chmod: vi.fn(),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
}));

const {
  readFile,
  writeFile,
  link,
  rename,
  unlink,
  appendFile,
  mkdir,
  chmod,
} = await import("node:fs/promises");
const { existsSync } = await import("node:fs");
const { loadMessages, appendMessage, loadOrCreateSessionTimeAnchor } =
  await import("./session.js");

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockLink = vi.mocked(link);
const mockRename = vi.mocked(rename);
const mockUnlink = vi.mocked(unlink);
const mockAppendFile = vi.mocked(appendFile);
const mockMkdir = vi.mocked(mkdir);
const mockChmod = vi.mocked(chmod);
const mockExistsSync = vi.mocked(existsSync);

describe("loadMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("JSONL を正しくパースして返す", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n',
    );

    const result = await loadMessages("group1", "session-a");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "user", content: "hello" });
    expect(result[1]).toEqual({ role: "assistant", content: "hi" });
  });

  it("ファイルが存在しない場合は空配列を返す", async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await loadMessages("group1", "session-a");

    expect(result).toEqual([]);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("空ファイルは空配列を返す", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("");

    const result = await loadMessages("group1", "session-a");

    expect(result).toEqual([]);
  });

  it("空白行のみのファイルは空配列を返す", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue("\n\n   \n");

    const result = await loadMessages("group1", "session-a");

    expect(result).toEqual([]);
  });

  it("reasoning フィールドを除去する", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      '{"role":"assistant","reasoning":"内部思考","content":"hi"}\n',
    );

    const result = await loadMessages("group1", "session-x");

    expect(result[0]).not.toHaveProperty("reasoning");
    expect(result[0]).toMatchObject({ role: "assistant", content: "hi" });
  });

  it("content 内の thinking ブロックを除去する", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(
      '{"role":"assistant","content":[{"type":"thinking","thinking":"思考中"},{"type":"text","text":"hi"}]}\n',
    );

    const result = await loadMessages("group1", "session-x");

    const assistantMsg = result[0] as {
      role: "assistant";
      content: Array<{ type: string }>;
    };
    const content = assistantMsg.content;
    expect(content.some((b) => b.type === "thinking")).toBe(false);
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "text", text: "hi" });
  });

  it("パストラバーサルを含むグループ名はエラー", async () => {
    await expect(loadMessages("../../etc/passwd", "session-a")).rejects.toThrow(
      "不正なグループ名",
    );
  });

  it("パストラバーサルを含むセッションIDはエラー", async () => {
    await expect(loadMessages("group1", "../secret")).rejects.toThrow(
      "不正なセッションID",
    );
  });

  it("空のグループ名はエラー", async () => {
    await expect(loadMessages("", "session-a")).rejects.toThrow(
      "不正なグループ名",
    );
  });

  it("空のセッションIDはエラー", async () => {
    await expect(loadMessages("group1", "")).rejects.toThrow(
      "不正なセッションID",
    );
  });
});

describe("loadOrCreateSessionTimeAnchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockLink.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockUnlink.mockResolvedValue(undefined);
  });

  it("既存sidecarの時刻を再利用する", async () => {
    mockReadFile.mockResolvedValue("123456\n");

    const result = await loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      999999,
    );

    expect(result).toBe(123456);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("sidecarがなければ完成済みtmpをno-clobberで原子的に公開する", async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const result = await loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      1787868000000,
    );

    expect(result).toBe(1787868000000);
    const temporaryFile = String(mockWriteFile.mock.calls[0]?.[0]);
    expect(temporaryFile).toContain("session-a.time-anchor.");
    expect(temporaryFile).toEndWith(".tmp");
    expect(mockWriteFile).toHaveBeenCalledWith(
      temporaryFile,
      "1787868000000\n",
      { encoding: "utf-8", mode: 0o666, flag: "wx" },
    );
    expect(mockLink).toHaveBeenCalledWith(
      temporaryFile,
      expect.stringMatching(/session-a\.time-anchor$/),
    );
    expect(mockUnlink).toHaveBeenCalledWith(temporaryFile);
  });

  it("初期化競合では先に原子的に公開されたsidecarを正本にする", async () => {
    mockReadFile
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      )
      .mockResolvedValueOnce("111111\n");
    mockLink.mockRejectedValue(
      Object.assign(new Error("EEXIST"), { code: "EEXIST" }),
    );

    const result = await loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      222222,
    );

    expect(result).toBe(111111);
    expect(mockRename).not.toHaveBeenCalled();
  });

  it("旧実装が残した空またはpartial sidecarは原子的に自己修復する", async () => {
    mockReadFile.mockResolvedValue("not-a-timestamp\n");

    const result = await loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      333333,
    );

    expect(result).toBe(333333);
    const temporaryFile = String(mockWriteFile.mock.calls[0]?.[0]);
    expect(mockRename).toHaveBeenCalledWith(
      temporaryFile,
      expect.stringMatching(/session-a\.time-anchor$/),
    );
    expect(mockUnlink).toHaveBeenCalledWith(temporaryFile);
  });

  it("競合相手が不完全なsidecarを公開していても完成済みtmpで復旧する", async () => {
    mockReadFile
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      )
      .mockResolvedValueOnce("");
    mockLink.mockRejectedValue(
      Object.assign(new Error("EEXIST"), { code: "EEXIST" }),
    );

    const result = await loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      444444,
    );

    expect(result).toBe(444444);
    expect(mockRename).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp$/),
      expect.stringMatching(/session-a\.time-anchor$/),
    );
  });
});

describe("appendMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockAppendFile.mockResolvedValue(undefined);
  });

  it("メッセージを追記する", async () => {
    await appendMessage("group1", "session-a", {
      role: "user",
      content: "hello",
      timestamp: 123,
    });

    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining("group1"), {
      recursive: true,
      mode: 0o777,
    });
    expect(mockAppendFile).toHaveBeenCalledWith(
      expect.stringContaining("session-a.jsonl"),
      '{"role":"user","content":"hello","timestamp":123}\n',
      { encoding: "utf-8", mode: 0o666 },
    );
  });

  it("reasoning フィールドを保存しない", async () => {
    await appendMessage("group1", "session-a", {
      role: "assistant",
      reasoning: "内部思考",
      content: "hi",
      timestamp: 123,
    } as unknown as Parameters<typeof appendMessage>[2]);

    const saved = JSON.parse(
      (mockAppendFile.mock.calls[0][1] as string).trim(),
    );
    expect(saved).not.toHaveProperty("reasoning");
    expect(saved.content).toBe("hi");
  });

  it("content 内の thinking ブロックを保存しない", async () => {
    await appendMessage("group1", "session-a", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考中" },
        { type: "text", text: "hi" },
      ],
      timestamp: 123,
    } as unknown as Parameters<typeof appendMessage>[2]);

    const saved = JSON.parse(
      (mockAppendFile.mock.calls[0][1] as string).trim(),
    );
    expect(saved.content).toHaveLength(1);
    expect(saved.content[0]).toEqual({ type: "text", text: "hi" });
  });

  it("パストラバーサルを含むグループ名はエラー", async () => {
    await expect(
      appendMessage("../../etc/passwd", "session-a", {
        role: "user",
        content: "x",
        timestamp: 123,
      }),
    ).rejects.toThrow("不正なグループ名");
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it("パストラバーサルを含むセッションIDはエラー", async () => {
    await expect(
      appendMessage("group1", "../secret", {
        role: "user",
        content: "x",
        timestamp: 123,
      }),
    ).rejects.toThrow("不正なセッションID");
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockAppendFile).not.toHaveBeenCalled();
  });
});
