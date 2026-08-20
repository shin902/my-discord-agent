import { describe, expect, it } from "vitest";
import { findGroupByName, loadGroups } from "./groups.js";
import type { JsonValue } from "./config.js";

const setupRawGroups = (raw: JsonValue[]) => () => Promise.resolve(raw);

describe("loadGroups", () => {
  it("mounts が無いグループも読み込める", async () => {
    const rawGroups = setupRawGroups([{ name: "chat", channels: [] }]);
    const groups = await loadGroups(rawGroups);
    expect(groups[0].mounts).toBeUndefined();
  });

  it("mounts を含むグループ設定をパースできる", async () => {
    const rawGroups = setupRawGroups([
      {
        name: "chat",
        channels: [],
        mounts: [
          { host: "/host/repo", container: "/repo" },
          { host: "relative/dir", container: "/data", readOnly: true },
        ],
      },
    ]);
    const groups = await loadGroups(rawGroups);
    expect(groups[0].mounts).toEqual([
      { host: "/host/repo", container: "/repo" },
      { host: "relative/dir", container: "/data", readOnly: true },
    ]);
  });

  it("mounts.container が / で始まらない場合はエラー", async () => {
    const rawGroups = setupRawGroups([
      {
        name: "chat",
        channels: [],
        mounts: [{ host: "/host/repo", container: "repo" }],
      },
    ]);
    await expect(loadGroups(rawGroups)).rejects.toThrow(
      "mounts.container は絶対パスで指定してください",
    );
  });

  it("model/tools/allowMention/toolLogArgs/skills を含むグループ設定をパースできる", async () => {
    const rawGroups = setupRawGroups([
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
    const groups = await loadGroups(rawGroups);
    expect(groups[0]).toMatchObject({
      model: { provider: "zai", modelId: "glm-4.7-flash" },
      tools: ["tavily-search"],
      allowMention: true,
      toolLogArgs: true,
      skills: ["session-logs"],
    });
  });

  it('skills は全ロードを示す "*" もパースできる', async () => {
    const rawGroups = setupRawGroups([
      { name: "chat", channels: [], skills: "*" },
    ]);
    const groups = await loadGroups(rawGroups);
    expect(groups[0].skills).toBe("*");
  });

  it("エージェント設定フィールドは省略可能", async () => {
    const rawGroups = setupRawGroups([{ name: "chat", channels: [] }]);
    const groups = await loadGroups(rawGroups);
    expect(groups[0].model).toBeUndefined();
    expect(groups[0].tools).toBeUndefined();
    expect(groups[0].allowMention).toBeUndefined();
    expect(groups[0].toolLogArgs).toBeUndefined();
    expect(groups[0].skills).toBeUndefined();
  });
});

describe("findGroupByName", () => {
  it("name に一致するグループ設定を返す", async () => {
    const rawGroups = setupRawGroups([
      { name: "chat", channels: [] },
      {
        name: "thread",
        channels: [],
        mounts: [{ host: "/host/repo", container: "/repo" }],
      },
    ]);
    const group = await findGroupByName("thread", rawGroups);
    expect(group?.mounts).toEqual([{ host: "/host/repo", container: "/repo" }]);
  });

  it("一致しない場合は undefined を返す", async () => {
    const rawGroups = setupRawGroups([{ name: "chat", channels: [] }]);
    expect(await findGroupByName("nonexistent", rawGroups)).toBeUndefined();
  });
});
