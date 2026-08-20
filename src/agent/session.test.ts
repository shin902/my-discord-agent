import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createSessionStore, type SessionFileSystem } from "./session.js";

function fakeFiles(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const dirs: string[] = [];
  const fs: SessionFileSystem = {
    exists: (file) => files.has(file),
    read: async (file) => files.get(file) ?? "",
    append: async (file, data) => {
      files.set(file, `${files.get(file) ?? ""}${data}`);
    },
    makeDirectory: async (dir) => {
      dirs.push(dir);
    },
    setMode: async () => {},
  };
  return { fs, files, dirs };
}
const store = (files: Record<string, string> = {}) =>
  createSessionStore("/sessions", fakeFiles(files).fs);

describe("loadMessages", () => {
  it("JSONL を正しくパースして返す", async () => {
    const result = await store({
      "/sessions/group1/session-a.jsonl":
        '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi"}\n',
    }).load("group1", "session-a");
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });
  it("ファイルが存在しない場合は空配列を返す", async () => {
    expect(await store().load("group1", "session-a")).toEqual([]);
  });
  it("空ファイルは空配列を返す", async () => {
    expect(
      await store({ "/sessions/group1/session-a.jsonl": "" }).load(
        "group1",
        "session-a",
      ),
    ).toEqual([]);
  });
  it("空白行のみのファイルは空配列を返す", async () => {
    expect(
      await store({ "/sessions/group1/session-a.jsonl": "\n  \n" }).load(
        "group1",
        "session-a",
      ),
    ).toEqual([]);
  });
  it("reasoning フィールドを除去する", async () => {
    const result = await store({
      "/sessions/group1/session-x.jsonl":
        '{"role":"assistant","reasoning":"内部思考","content":"hi"}\n',
    }).load("group1", "session-x");
    expect(result[0]).toEqual({ role: "assistant", content: "hi" });
  });
  it("content 内の thinking ブロックを除去する", async () => {
    const result = await store({
      "/sessions/group1/session-x.jsonl":
        '{"role":"assistant","content":[{"type":"thinking"},{"type":"text","text":"hi"}]}\n',
    }).load("group1", "session-x");
    expect(result[0]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
    });
  });
  it.each([
    ["../../etc/passwd", "グループ名"],
    ["", "グループ名"],
  ])("不正なグループ名を拒否する", async (name, label) => {
    await expect(store().load(name, "session-a")).rejects.toThrow(
      `不正な${label}`,
    );
  });
  it.each([
    ["../secret", "セッションID"],
    ["", "セッションID"],
  ])("不正なセッションIDを拒否する", async (name, label) => {
    await expect(store().load("group1", name)).rejects.toThrow(
      `不正な${label}`,
    );
  });
});

describe("appendMessage", () => {
  it("メッセージを追記する", async () => {
    const fixture = fakeFiles();
    const session = createSessionStore("/sessions", fixture.fs);
    await session.append("group1", "session-a", {
      role: "user",
      content: "hello",
      timestamp: 123,
    });
    expect(fixture.files.get("/sessions/group1/session-a.jsonl")).toBe(
      '{"role":"user","content":"hello","timestamp":123}\n',
    );
  });
  it("reasoning と thinking を保存しない", async () => {
    const fixture = fakeFiles();
    const session = createSessionStore("/sessions", fixture.fs);
    const message = Object.assign(
      {
        role: "assistant",
        api: "test",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "x", thinkingSignature: "x" },
          { type: "text", text: "hi" },
        ],
        timestamp: 123,
      } satisfies AgentMessage,
      { reasoning: "内部思考" },
    );
    await session.append("group1", "session-a", message);
    expect(
      JSON.parse(fixture.files.get("/sessions/group1/session-a.jsonl") ?? "{}"),
    ).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      timestamp: 123,
    });
  });
  it.each([
    ["../../etc/passwd", "グループ名"],
    ["", "グループ名"],
  ])("不正なグループ名を拒否する", async (name, label) => {
    await expect(
      store().append(name, "session-a", {
        role: "user",
        content: "x",
        timestamp: 1,
      }),
    ).rejects.toThrow(`不正な${label}`);
  });
  it.each([
    ["../secret", "セッションID"],
    ["", "セッションID"],
  ])("不正なセッションIDを拒否する", async (name, label) => {
    await expect(
      store().append("group1", name, {
        role: "user",
        content: "x",
        timestamp: 1,
      }),
    ).rejects.toThrow(`不正な${label}`);
  });
});
