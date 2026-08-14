import { afterEach, describe, expect, it, vi } from "vitest";

const setupRawGroups = async (raw: unknown) => {
  vi.resetModules();
  vi.doMock("./config.js", () => ({
    loadRawGroups: vi.fn().mockResolvedValue(raw),
  }));
  return import("./groups.js");
};

describe("loadGroups", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("mounts が無いグループも読み込める", async () => {
    const { loadGroups } = await setupRawGroups([
      { name: "chat", channels: [] },
    ]);
    const groups = await loadGroups();
    expect(groups[0].mounts).toBeUndefined();
  });

  it("mounts を含むグループ設定をパースできる", async () => {
    const { loadGroups } = await setupRawGroups([
      {
        name: "chat",
        channels: [],
        mounts: [
          { host: "/host/repo", container: "/repo" },
          { host: "relative/dir", container: "/data", readOnly: true },
        ],
      },
    ]);
    const groups = await loadGroups();
    expect(groups[0].mounts).toEqual([
      { host: "/host/repo", container: "/repo" },
      { host: "relative/dir", container: "/data", readOnly: true },
    ]);
  });

  it("mounts.container が / で始まらない場合はエラー", async () => {
    const { loadGroups } = await setupRawGroups([
      {
        name: "chat",
        channels: [],
        mounts: [{ host: "/host/repo", container: "repo" }],
      },
    ]);
    await expect(loadGroups()).rejects.toThrow(
      "mounts.container は絶対パスで指定してください",
    );
  });

  it("model/tools/allowMention/toolLogArgs/skills を含むグループ設定をパースできる", async () => {
    const { loadGroups } = await setupRawGroups([
      {
        name: "chat",
        model: { provider: "zai", modelId: "glm-4.7-flash" },
        tools: ["tavily-search"],
        allowMention: true,
        toolLogArgs: true,
        skills: ["session-logs"],
        channels: [],
      },
    ]);
    const groups = await loadGroups();
    expect(groups[0]).toMatchObject({
      model: { provider: "zai", modelId: "glm-4.7-flash" },
      tools: ["tavily-search"],
      allowMention: true,
      toolLogArgs: true,
      skills: ["session-logs"],
    });
  });

  it('skills は全ロードを示す "*" もパースできる', async () => {
    const { loadGroups } = await setupRawGroups([
      { name: "chat", channels: [], skills: "*" },
    ]);
    const groups = await loadGroups();
    expect(groups[0].skills).toBe("*");
  });

  it("エージェント設定フィールドは省略可能", async () => {
    const { loadGroups } = await setupRawGroups([
      { name: "chat", channels: [] },
    ]);
    const groups = await loadGroups();
    expect(groups[0].model).toBeUndefined();
    expect(groups[0].tools).toBeUndefined();
    expect(groups[0].allowMention).toBeUndefined();
    expect(groups[0].toolLogArgs).toBeUndefined();
    expect(groups[0].skills).toBeUndefined();
  });
});

describe("findGroupByName", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("name に一致するグループ設定を返す", async () => {
    const { findGroupByName } = await setupRawGroups([
      { name: "chat", channels: [] },
      {
        name: "thread",
        channels: [],
        mounts: [{ host: "/host/repo", container: "/repo" }],
      },
    ]);
    const group = await findGroupByName("thread");
    expect(group?.mounts).toEqual([{ host: "/host/repo", container: "/repo" }]);
  });

  it("一致しない場合は undefined を返す", async () => {
    const { findGroupByName } = await setupRawGroups([
      { name: "chat", channels: [] },
    ]);
    expect(await findGroupByName("nonexistent")).toBeUndefined();
  });
});
