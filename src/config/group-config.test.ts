import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  stat: vi.fn(),
  cp: vi.fn(),
  mkdir: vi.fn(),
}));

const { readFile, stat, cp, mkdir } = await import("node:fs/promises");
const {
  loadGroupSystemPrompt,
  initGroupPrompts,
  ensureGroupDirs,
  ensureGroupSkills,
} = await import("./group-config.js");

// readFile はオーバーロードがあり vi.mocked がデフォルトで Buffer 返しの overload を選ぶため、
// string 返しの overload に一度だけキャストして各テストで as any を使わずに済むようにする。
const mockReadFile = vi.mocked(readFile) as unknown as Mock<
  () => Promise<string>
>;
const mockStat = vi.mocked(stat) as unknown as Mock<
  () => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>
>;
const mockCp = vi.mocked(cp);
const mockMkdir = vi.mocked(mkdir);

const statDir = () =>
  Promise.resolve({ isDirectory: () => true, isFile: () => false });
const statFile = () =>
  Promise.resolve({ isDirectory: () => false, isFile: () => true });
const statMissing = () =>
  Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

beforeEach(() => {
  mockReadFile.mockReset();
  mockStat.mockReset();
  mockCp.mockReset();
  mockMkdir.mockReset();
  mockCp.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
  mockStat.mockImplementation(statMissing);
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

describe("initGroupPrompts", () => {
  // 既存テストのキャッシュ汚染を避けるため init-* 系のグループ名を使用
  it("システムプロンプトを読み込んでキャッシュする", async () => {
    mockReadFile.mockResolvedValueOnce("あなたは役立つアシスタントです。");

    await initGroupPrompts([{ name: "init-valid", channels: [] }]);

    mockReadFile.mockReset();
    expect(await loadGroupSystemPrompt("init-valid")).toBe(
      "あなたは役立つアシスタントです。",
    );
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("refresh を指定するとキャッシュ済みの system prompt を再読み込みする", async () => {
    mockReadFile.mockResolvedValueOnce("初期プロンプト");
    await initGroupPrompts([{ name: "init-refresh", channels: [] }]);

    mockReadFile.mockResolvedValueOnce("更新済みプロンプト");
    await expect(
      loadGroupSystemPrompt("init-refresh", { refresh: true }),
    ).resolves.toBe("更新済みプロンプト");
  });

  it("AGENTS.md がない場合は null がキャッシュされる", async () => {
    mockReadFile.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await initGroupPrompts([{ name: "init-absent", channels: [] }]);

    mockReadFile.mockReset();
    expect(await loadGroupSystemPrompt("init-absent")).toBeNull();
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("skills が指定されている場合は ensureGroupSkills を呼ぶ", async () => {
    mockReadFile.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    mockStat
      .mockImplementationOnce(statMissing) // skill dest missing
      .mockImplementationOnce(statDir); // skill template exists

    await initGroupPrompts([
      { name: "init-skills", channels: [], skills: ["explain"] },
    ]);

    expect(mockCp).toHaveBeenCalledOnce();
  });

  it('skills が "*" の場合はテンプレートコピーしない', async () => {
    mockReadFile.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await initGroupPrompts([
      { name: "init-all-skills", channels: [], skills: "*" },
    ]);

    expect(mockCp).not.toHaveBeenCalled();
  });
});

describe("ensureGroupDirs", () => {
  it("不正なグループ名はエラー", async () => {
    await expect(ensureGroupDirs(["../../evil"])).rejects.toThrow(
      "不正なグループ名",
    );
  });

  it("グループフォルダが既に存在する場合は cp を呼ばない", async () => {
    mockStat
      .mockImplementationOnce(statFile) // templates/group/AGENTS.md が存在
      .mockImplementationOnce(statDir); // group dir が存在
    await ensureGroupDirs(["existing-group"]);
    expect(mockCp).not.toHaveBeenCalled();
  });

  it("グループフォルダが存在せずテンプレートがある場合は cp を呼ぶ", async () => {
    mockStat
      .mockImplementationOnce(statFile) // templates/group/AGENTS.md が存在
      .mockImplementationOnce(statMissing); // group dir missing
    await ensureGroupDirs(["new-group"]);
    expect(mockMkdir).toHaveBeenCalledOnce();
    expect(mockCp).toHaveBeenCalledOnce();
  });

  it("テンプレートが存在しない場合は cp を呼ばない", async () => {
    mockStat
      .mockImplementationOnce(statMissing) // templates/group/AGENTS.md missing
      .mockImplementationOnce(statMissing); // group dir missing
    await ensureGroupDirs(["new-group"]);
    expect(mockCp).not.toHaveBeenCalled();
  });

  it("cp が失敗してもエラーをスローせず続行する", async () => {
    mockStat
      .mockImplementationOnce(statFile) // templates/group/AGENTS.md が存在
      .mockImplementationOnce(statMissing); // group dir missing
    mockCp.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    await expect(ensureGroupDirs(["broken-group"])).resolves.toBeUndefined();
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
    // 実装は dest → src の順で _dirExists を呼ぶ（既存なら早期リターン）
    mockStat
      .mockImplementationOnce(statMissing) // dest: skill missing
      .mockImplementationOnce(statMissing); // src: template missing
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

  it("cp が失敗してもエラーをスローせず続行する", async () => {
    mockStat
      .mockImplementationOnce(statMissing) // skill dest missing
      .mockImplementationOnce(statDir); // skill template exists
    mockCp.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    await expect(
      ensureGroupSkills("mygroup", ["explain"]),
    ).resolves.toBeUndefined();
  });
});
