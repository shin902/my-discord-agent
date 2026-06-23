import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxMessage } from "./inbox.js";

// inbox.ts は node:fs / node:fs/promises を直接使ってファイルI/Oするため、
// 実ファイルに触れずにロジックを検証するためインメモリストアでモックする。
let store: { content: string | null } = { content: null };

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => store.content !== null),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => store.content ?? ""),
  writeFile: vi.fn(async (_path: string, data: string) => {
    store.content = data;
  }),
  appendFile: vi.fn(async (_path: string, data: string) => {
    store.content = (store.content ?? "") + data;
  }),
}));

const { appendInbox, peekAllUnclaimedInbox, removeInboxById, updateInboxById } =
  await import("./inbox.js");

function makeMsgInput(
  overrides?: Partial<Omit<InboxMessage, "id" | "retries">>,
): Omit<InboxMessage, "id" | "retries"> {
  return {
    channelId: "ch-1",
    groupName: "default",
    sessionId: "ch-1",
    messageId: "msg-original",
    content: "hello",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function readLines(): InboxMessage[] {
  const text = store.content ?? "";
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as InboxMessage);
}

beforeEach(() => {
  store = { content: null };
  vi.clearAllMocks();
});

describe("appendInbox", () => {
  it("1件追記後、ファイル内容に正しいJSONLが追加される", async () => {
    await appendInbox(makeMsgInput());

    const lines = readLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      channelId: "ch-1",
      groupName: "default",
      sessionId: "ch-1",
      messageId: "msg-original",
      content: "hello",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });

  it("id と retries が自動付与される", async () => {
    await appendInbox(makeMsgInput());

    const lines = readLines();
    expect(typeof lines[0].id).toBe("string");
    expect(lines[0].id.length).toBeGreaterThan(0);
    expect(lines[0].retries).toBe(0);
  });

  it("複数回追記すると末尾に追加されていく", async () => {
    await appendInbox(makeMsgInput({ content: "first" }));
    await appendInbox(makeMsgInput({ content: "second" }));

    const lines = readLines();
    expect(lines).toHaveLength(2);
    expect(lines[0].content).toBe("first");
    expect(lines[1].content).toBe("second");
  });
});

describe("peekAllUnclaimedInbox", () => {
  it("ファイル未作成時に空配列を返す", async () => {
    const result = await peekAllUnclaimedInbox(new Set());
    expect(result).toEqual([]);
  });

  it("空ファイルの場合 空配列を返す", async () => {
    store.content = "";
    const result = await peekAllUnclaimedInbox(new Set());
    expect(result).toEqual([]);
  });

  it("excludeIds に含まれないメッセージをファイル順のまま全件返す", async () => {
    await appendInbox(makeMsgInput({ content: "first" }));
    await appendInbox(makeMsgInput({ content: "second" }));
    await appendInbox(makeMsgInput({ content: "third" }));
    const lines = readLines();
    const firstId = lines[0].id;

    const result = await peekAllUnclaimedInbox(new Set([firstId]));
    expect(result).toHaveLength(2);
    expect(result.map((m) => m.content)).toEqual(["second", "third"]);
  });

  it("ファイルは変更しない（再度呼んでも同じ結果が返る）", async () => {
    await appendInbox(makeMsgInput({ content: "first" }));
    const beforeContent = store.content;

    const result1 = await peekAllUnclaimedInbox(new Set());
    const result2 = await peekAllUnclaimedInbox(new Set());

    expect(store.content).toBe(beforeContent);
    expect(result1).toEqual(result2);
  });

  it("全件が excludeIds に含まれる場合 空配列を返す", async () => {
    await appendInbox(makeMsgInput({ content: "first" }));
    await appendInbox(makeMsgInput({ content: "second" }));
    const lines = readLines();
    const allIds = new Set(lines.map((l) => l.id));

    const result = await peekAllUnclaimedInbox(allIds);
    expect(result).toEqual([]);
  });
});

describe("removeInboxById", () => {
  it("指定idの行のみ削除され、他の行は残る", async () => {
    await appendInbox(makeMsgInput({ content: "first" }));
    await appendInbox(makeMsgInput({ content: "second" }));
    await appendInbox(makeMsgInput({ content: "third" }));
    const before = readLines();
    const targetId = before[1].id;

    await removeInboxById(targetId);

    const after = readLines();
    expect(after).toHaveLength(2);
    expect(after.map((m) => m.content)).toEqual(["first", "third"]);
  });

  it("存在しないidを指定しても他の行に影響しない", async () => {
    await appendInbox(makeMsgInput({ content: "first" }));
    await appendInbox(makeMsgInput({ content: "second" }));
    const before = readLines();

    await removeInboxById("nonexistent-id");

    const after = readLines();
    expect(after).toEqual(before);
  });

  it("最後の1件を削除した場合ファイル内容が空になる", async () => {
    await appendInbox(makeMsgInput({ content: "only" }));
    const before = readLines();

    await removeInboxById(before[0].id);

    expect(store.content).toBe("");
    expect(readLines()).toHaveLength(0);
  });

  it("ファイル未作成時は何もせず正常終了する", async () => {
    await expect(removeInboxById("any-id")).resolves.toBeUndefined();
    expect(store.content).toBeNull();
  });
});

describe("updateInboxById", () => {
  it("指定idの行のフィールドのみ更新され、他のフィールド・他の行は変更されない", async () => {
    await appendInbox(makeMsgInput({ content: "first" }));
    await appendInbox(makeMsgInput({ content: "second" }));
    const before = readLines();
    const targetId = before[1].id;

    await updateInboxById(targetId, { retries: 3 });

    const after = readLines();
    expect(after[0]).toEqual(before[0]); // 他の行は変更なし
    expect(after[1]).toEqual({ ...before[1], retries: 3 });
    expect(after[1].content).toBe("second"); // 他フィールドは保持
  });

  it("行の順序（位置）が変わらない", async () => {
    await appendInbox(makeMsgInput({ content: "first" }));
    await appendInbox(makeMsgInput({ content: "second" }));
    await appendInbox(makeMsgInput({ content: "third" }));
    const before = readLines();
    const targetId = before[2].id;

    await updateInboxById(targetId, { retries: 1 });

    const after = readLines();
    expect(after.map((m) => m.content)).toEqual(["first", "second", "third"]);
  });

  it("存在しないidを指定しても他の行に影響しない", async () => {
    await appendInbox(makeMsgInput({ content: "first" }));
    const before = readLines();

    await updateInboxById("nonexistent-id", { retries: 5 });

    const after = readLines();
    expect(after).toEqual(before);
  });

  it("ファイル未作成時は何もせず正常終了する", async () => {
    await expect(
      updateInboxById("any-id", { retries: 1 }),
    ).resolves.toBeUndefined();
    expect(store.content).toBeNull();
  });
});
