import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  cp: vi.fn(),
}));

const { readFile, stat, cp } = await import("node:fs/promises");
const {
  loadGroupConfig,
  loadGroupSystemPrompt,
  initGroupConfigs,
  ensureGroupDirs,
  ensureGroupSkills,
} = await import("./group-config.js");

// readFile はオーバーロードがあり vi.mocked がデフォルトで Buffer 返しの overload を選ぶため、
// string 返しの overload に一度だけキャストして各テストで as any を使わずに済むようにする。
const mockReadFile = vi.mocked(readFile) as unknown as Mock<
  () => Promise<string>
>;
const mockStat = vi.mocked(stat) as unknown as Mock<
  () => Promise<{ isDirectory: () => boolean }>
>;
const mockCp = vi.mocked(cp);

const statDir = () => Promise.resolve({ isDirectory: () => true });
const statMissing = () =>
  Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

beforeEach(() => {
  mockReadFile.mockReset();
  mockStat.mockReset();
  mockCp.mockReset();
  mockCp.mockResolvedValue(undefined);
  mockStat.mockImplementation(statMissing);
});

describe("loadGroupConfig", () => {
  it("パストラバーサルを含むグループ名はエラー", async () => {
    await expect(loadGroupConfig("../../etc/passwd")).rejects.toThrow(
      "不正なグループ名",
    );
  });

  it("ファイルが存在しない場合は空オブジェクトを返す", async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    expect(await loadGroupConfig("nonexistent")).toEqual({});
  });

  it("ENOENT 以外のエラーは再スロー", async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );
    await expect(loadGroupConfig("test")).rejects.toThrow("EACCES");
  });

  it("不正な JSON はグループ名入りのエラーを投げる", async () => {
    mockReadFile.mockResolvedValue("{ invalid json }");
    await expect(loadGroupConfig("test")).rejects.toThrow(
      "グループ設定の JSON が不正です (test)",
    );
  });

  it("空ファイルはグループ名入りのエラーを投げる", async () => {
    mockReadFile.mockResolvedValue("");
    await expect(loadGroupConfig("test")).rejects.toThrow(
      "グループ設定の JSON が不正です (test)",
    );
  });

  it("スキーマに合わない JSON はグループ名入りのエラーを投げる", async () => {
    mockReadFile.mockResolvedValue('{"model":"invalid"}');
    await expect(loadGroupConfig("test")).rejects.toThrow(
      "グループ設定が不正です (test)",
    );
  });

  it("model フィールドなしの空オブジェクトはそのまま返す", async () => {
    mockReadFile.mockResolvedValue("{}");
    expect(await loadGroupConfig("test")).toEqual({});
  });

  it("有効な model 設定をパースして返す", async () => {
    mockReadFile.mockResolvedValue(
      '{"model":{"provider":"opencode-go","modelId":"kimi-k2.6"}}',
    );
    const config = await loadGroupConfig("test");
    expect(config.model).toEqual({
      provider: "opencode-go",
      modelId: "kimi-k2.6",
    });
  });
});

describe("loadGroupSystemPrompt", () => {
  it("パストラバーサルを含むグループ名はエラー", async () => {
    await expect(loadGroupSystemPrompt("../../etc/passwd")).rejects.toThrow(
      "不正なグループ名",
    );
  });

  it("ファイルが存在しない場合は null を返す", async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    expect(await loadGroupSystemPrompt("test")).toBeNull();
  });

  it("ENOENT 以外のエラーは再スロー", async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );
    await expect(loadGroupSystemPrompt("test")).rejects.toThrow("EACCES");
  });

  it("ファイルが存在する場合は内容を返す", async () => {
    mockReadFile.mockResolvedValue("あなたは役立つアシスタントです。");
    expect(await loadGroupSystemPrompt("test")).toBe(
      "あなたは役立つアシスタントです。",
    );
  });
});

describe("initGroupConfigs", () => {
  // 既存テストのキャッシュ汚染を避けるため init-* 系のグループ名を使用
  it("グループ設定を読み込んで Map を返す", async () => {
    mockReadFile
      .mockResolvedValueOnce(
        '{"model":{"provider":"opencode-go","modelId":"kimi-k2.6"}}',
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

    const map = await initGroupConfigs(["init-valid"]);

    expect(map.get("init-valid")).toEqual({
      model: { provider: "opencode-go", modelId: "kimi-k2.6" },
    });
  });

  it("group.json がない場合は空オブジェクトが Map に入る", async () => {
    mockReadFile
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

    const map = await initGroupConfigs(["init-absent"]);

    expect(map.get("init-absent")).toEqual({});
  });

  it("キャッシュ後の loadGroupConfig は readFile を呼ばない", async () => {
    mockReadFile
      .mockResolvedValueOnce(
        '{"model":{"provider":"opencode-go","modelId":"kimi-k2.6"}}',
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    mockStat.mockImplementation(statMissing);

    await initGroupConfigs(["init-cache-verify"]);
    mockReadFile.mockReset();

    const config = await loadGroupConfig("init-cache-verify");
    expect(mockReadFile).not.toHaveBeenCalled();
    expect(config).toEqual({
      model: { provider: "opencode-go", modelId: "kimi-k2.6" },
    });
  });
});

describe("ensureGroupDirs", () => {
  it("不正なグループ名はエラー", async () => {
    await expect(ensureGroupDirs(["../../evil"])).rejects.toThrow(
      "不正なグループ名",
    );
  });

  it("グループフォルダが既に存在する場合は cp を呼ばない", async () => {
    mockStat.mockImplementation(statDir); // template も group も存在
    await ensureGroupDirs(["existing-group"]);
    expect(mockCp).not.toHaveBeenCalled();
  });

  it("グループフォルダが存在せずテンプレートがある場合は cp を呼ぶ", async () => {
    mockStat
      .mockImplementationOnce(statDir) // template dir exists
      .mockImplementationOnce(statMissing); // group dir missing
    await ensureGroupDirs(["new-group"]);
    expect(mockCp).toHaveBeenCalledOnce();
  });

  it("テンプレートが存在しない場合は cp を呼ばない", async () => {
    mockStat
      .mockImplementationOnce(statMissing) // template dir missing
      .mockImplementationOnce(statMissing); // group dir missing
    await ensureGroupDirs(["new-group"]);
    expect(mockCp).not.toHaveBeenCalled();
  });
});

describe("ensureGroupSkills", () => {
  it("不正なグループ名はエラー", async () => {
    await expect(ensureGroupSkills("../../evil", ["explain"])).rejects.toThrow(
      "不正なグループ名",
    );
  });

  it("不正なスキル名はエラー", async () => {
    await expect(
      ensureGroupSkills("mygroup", ["../../../etc/passwd"]),
    ).rejects.toThrow("不正なスキル名");
  });

  it("スキルリストが空の場合は stat を呼ばない", async () => {
    await ensureGroupSkills("mygroup", []);
    expect(mockStat).not.toHaveBeenCalled();
  });

  it("スキルフォルダが既に存在する場合は cp を呼ばない", async () => {
    mockStat.mockImplementation(statDir); // skill dest exists
    await ensureGroupSkills("mygroup", ["explain"]);
    expect(mockCp).not.toHaveBeenCalled();
  });

  it("スキルフォルダが存在せずテンプレートがある場合は cp を呼ぶ", async () => {
    mockStat
      .mockImplementationOnce(statMissing) // skill dest missing
      .mockImplementationOnce(statDir); // skill template exists
    await ensureGroupSkills("mygroup", ["explain"]);
    expect(mockCp).toHaveBeenCalledOnce();
  });

  it("テンプレートにスキルがない場合は cp を呼ばない", async () => {
    mockStat
      .mockImplementationOnce(statMissing) // skill dest missing
      .mockImplementationOnce(statMissing); // skill template missing
    await ensureGroupSkills("mygroup", ["unknown-skill"]);
    expect(mockCp).not.toHaveBeenCalled();
  });

  it("複数スキルで存在するものはスキップ、ないものだけコピー", async () => {
    mockStat
      .mockImplementationOnce(statDir) // skill-a dest exists → skip
      .mockImplementationOnce(statMissing) // skill-b dest missing
      .mockImplementationOnce(statDir); // skill-b template exists
    await ensureGroupSkills("mygroup", ["skill-a", "skill-b"]);
    expect(mockCp).toHaveBeenCalledOnce();
  });
});
