import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { readFile, writeFile, link, rename, unlink, appendFile, mkdir, chmod } =
  await import("node:fs/promises");
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

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("完全なepoch-millisecond sidecarの時刻を再利用する", async () => {
    mockReadFile.mockResolvedValue("1787868000000\n");

    const result = await loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      999999,
    );

    expect(result).toBe(1787868000000);
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
  });

  it.each([
    444444,
    1787868000000.5,
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("不正なfallback (%s)はDate.now()へ置換し、保存値を再利用できる", async (fallback) => {
    const now = 1787868000123;
    vi.spyOn(Date, "now").mockReturnValue(now);
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const result = await loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      fallback,
    );

    expect(result).toBe(now);
    expect(mockWriteFile).toHaveBeenCalledWith(expect.any(String), `${now}\n`, {
      encoding: "utf-8",
      mode: 0o666,
      flag: "wx",
    });

    mockReadFile.mockResolvedValue(`${now}\n`);
    await expect(
      loadOrCreateSessionTimeAnchor("group1", "session-a", 444444),
    ).resolves.toBe(now);
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
    expect(temporaryFile).toMatch(/\.tmp$/);
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
      .mockResolvedValueOnce("1787869000000\n");
    mockLink.mockRejectedValue(
      Object.assign(new Error("EEXIST"), { code: "EEXIST" }),
    );

    const result = await loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      222222,
    );

    expect(result).toBe(1787869000000);
    expect(mockRename).not.toHaveBeenCalled();
  });

  it.each([
    "1787868\n",
    "1787868000000.5\n",
    "1.787868e12\n",
    "17878680000000\n",
    "999999999999\n",
  ])("不完全または不正なsidecar (%s)は原子的に自己修復する", async (content) => {
    mockReadFile.mockResolvedValue(content);

    const result = await loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      1787868000000,
    );

    expect(result).toBe(1787868000000);
    const temporaryFile = String(mockWriteFile.mock.calls[0]?.[0]);
    expect(mockLink).toHaveBeenCalledWith(
      temporaryFile,
      expect.stringMatching(/session-a\.time-anchor\.repair$/),
    );
    expect(mockRename).toHaveBeenCalledWith(
      temporaryFile,
      expect.stringMatching(/session-a\.time-anchor$/),
    );
    expect(mockUnlink).toHaveBeenCalledWith(
      expect.stringMatching(/session-a\.time-anchor\.repair$/),
    );
  });

  it.each([
    "1000000000000\n",
    "9999999999999\n",
  ])("13桁のepoch-millisecond境界値 (%s)は有効として再利用する", async (content) => {
    mockReadFile.mockResolvedValue(content);

    const result = await loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      1787868000000,
    );

    expect(result).toBe(Number(content));
    expect(mockWriteFile).not.toHaveBeenCalled();
    expect(mockRename).not.toHaveBeenCalled();
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
      1787868000000,
    );

    expect(result).toBe(1787868000000);
    expect(mockRename).toHaveBeenCalledWith(
      expect.stringMatching(/\.tmp$/),
      expect.stringMatching(/session-a\.time-anchor$/),
    );
  });

  it("初期read後にwinnerが公開されたcallerはwinnerを上書きしない", async () => {
    let initialReads = 0;
    let durableAnchor: number | undefined;
    let claimHeld = false;
    let releaseInitialReads!: () => void;
    const initialReadsReady = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    let releaseSecondWrite!: () => void;
    const secondWriteReady = new Promise<void>((resolve) => {
      releaseSecondWrite = resolve;
    });

    mockReadFile.mockImplementation(async (file) => {
      if (!String(file).endsWith(".time-anchor")) return "1787868\n";
      initialReads += 1;
      if (initialReads === 2) releaseInitialReads();
      await initialReadsReady;
      return durableAnchor === undefined ? "1787868\n" : `${durableAnchor}\n`;
    });
    mockWriteFile.mockImplementation(async (_file, content) => {
      if (String(content).includes("1787868000001")) {
        await secondWriteReady;
      }
    });
    mockLink.mockImplementation(async (source, destination) => {
      if (String(destination).endsWith(".repair")) {
        if (claimHeld) {
          throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
        }
        claimHeld = true;
        return;
      }
      if (durableAnchor !== undefined) {
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      }
      const write = mockWriteFile.mock.calls.find(([file]) => file === source);
      durableAnchor = Number(String(write?.[1]).trim());
    });
    mockRename.mockImplementation(async (source, destination) => {
      expect(String(source)).toMatch(/\.tmp$/);
      expect(String(destination)).toMatch(/session-a\.time-anchor$/);
      const write = mockWriteFile.mock.calls.find(([file]) => file === source);
      durableAnchor = Number(String(write?.[1]).trim());
    });
    mockUnlink.mockImplementation(async (file) => {
      if (String(file).endsWith(".repair")) claimHeld = false;
    });

    const firstPromise = loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      1787868000000,
    );
    const secondPromise = loadOrCreateSessionTimeAnchor(
      "group1",
      "session-a",
      1787868000001,
    );

    const first = await firstPromise;
    releaseSecondWrite();
    const second = await secondPromise;

    expect(first).toBe(1787868000000);
    expect(second).toBe(first);
    expect(durableAnchor).toBe(first);
    expect(mockRename).toHaveBeenCalledTimes(1);
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
