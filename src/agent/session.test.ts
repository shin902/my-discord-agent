import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let testRoot: string;
let root: string;
let session: typeof import("./session.js");

beforeAll(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
  root = path.join(testRoot, "sessions");
  process.env.SESSIONS_DIR = root;
  session = await import("./session.js");
});

afterAll(async () => {
  delete process.env.SESSIONS_DIR;
  await rm(testRoot, { recursive: true, force: true });
});

function dbFor(group: string): Database.Database {
  return new Database(path.join(root, group, "sessions.sqlite"), {
    readonly: true,
  });
}

describe("SQLite session trajectory store", () => {
  it("存在しないsessionは空配列を返し、per-group DBを作成する", async () => {
    await expect(
      session.loadMessages("empty-group", "missing"),
    ).resolves.toEqual([]);
    const db = dbFor("empty-group");
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(
      (
        db.pragma("table_info(sessions)") as Array<{
          name: string;
          dflt_value: string | null;
        }>
      ).find(({ name }) => name === "agent_id")?.dflt_value,
    ).toBe("'main'");
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name).sort()).toEqual([
      "session_entries",
      "sessions",
      "sqlite_sequence",
    ]);
    db.close();
  });

  it("messageを順序どおり追記しreasoning/thinkingを保存しない", async () => {
    await session.appendMessage("group1", "session-a", {
      role: "user",
      content: "hello",
      timestamp: 123,
    });
    await session.appendMessage("group1", "session-a", {
      role: "assistant",
      reasoning: "internal",
      reasoning_content: "legacy",
      content: [
        { type: "thinking", thinking: "secret" },
        { type: "text", text: "hi" },
      ],
      timestamp: 124,
    } as unknown as AgentMessage);

    const messages = await session.loadMessages("group1", "session-a");
    expect(messages).toEqual([
      { role: "user", content: "hello", timestamp: 123 },
      {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        timestamp: 124,
      },
    ]);

    const db = dbFor("group1");
    expect(
      db
        .prepare(
          "SELECT sequence, entry_type FROM session_entries WHERE session_id=? ORDER BY sequence",
        )
        .all("session-a"),
    ).toEqual([
      { sequence: 1, entry_type: "user" },
      { sequence: 2, entry_type: "assistant" },
    ]);
    db.close();
  });

  it("同じsession/sourceの再送は元のentryを返し、本文・時刻を上書きしない", async () => {
    const source = {
      kind: "discord" as const,
      sourceId: "message-1",
      actorId: "user-1",
      messageType: 0 as const,
    };
    const original = { role: "user" as const, content: "hello", timestamp: 1 };
    const first = await session.appendMessage(
      "dedupe",
      "session-a",
      original,
      source,
    );
    const replays = await Promise.all(
      Array.from({ length: 5 }, () =>
        session.appendMessage(
          "dedupe",
          "session-a",
          { ...original, content: "edited", timestamp: 2 },
          source,
        ),
      ),
    );
    expect(replays).toEqual(Array(5).fill(first));
    expect(await session.loadMessages("dedupe", "session-a")).toEqual([
      original,
    ]);
    expect(
      await session.appendMessage("dedupe", "session-b", original, source),
    ).not.toBe(first);
  });

  it("並行appendを壊さず一意なsequenceとして保存する", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        session.appendMessage("concurrent", "shared", {
          role: "user",
          content: `message-${index}`,
          timestamp: index,
        }),
      ),
    );
    const messages = await session.loadMessages("concurrent", "shared");
    expect(messages).toHaveLength(20);
    expect(
      new Set(
        messages.map((message) => (message as { content?: unknown }).content),
      ).size,
    ).toBe(20);
  });

  it("concurrent fresh DB opens recheck v5 after the initialization lock", async () => {
    const group = "fresh-race";
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(
      new URL("./__fixtures__/session-migration.cjs", import.meta.url),
      { workerData: { root, group, version: 0, gate: gate.buffer } },
    );
    const signal = AbortSignal.timeout(10_000);
    try {
      expect(await once(worker, "message", { signal })).toEqual([
        "stale-version-read",
      ]);
      await session.appendMessage(group, "main-session", {
        role: "user",
        content: "main message",
        timestamp: 1,
      });
      const finished = once(worker, "message", { signal });
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      expect(await finished).toEqual([
        { status: "appended", recheckedInTransaction: true },
      ]);
      expect(await session.loadMessages(group, "worker-session")).toHaveLength(
        1,
      );
      const db = dbFor(group);
      expect(db.pragma("user_version", { simple: true })).toBe(5);
      db.close();
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      await worker.terminate();
    }
  }, 15_000);

  it("v4 DBをruntimeで暗黙移行しない", async () => {
    const group = "legacy-v4";
    await mkdir(path.join(root, group), { recursive: true });
    const db = new Database(path.join(root, group, "sessions.sqlite"));
    db.pragma("user_version = 4");
    db.close();
    await expect(session.loadMessages(group, "old")).rejects.toThrow(
      "未対応のsession DB schema version",
    );
    const inspect = dbFor(group);
    expect(inspect.pragma("user_version", { simple: true })).toBe(4);
    inspect.close();
  });

  it("excludes snapshot-only Bot sessions until user input exists", async () => {
    const snapshot = {
      role: "custom" as const,
      customType: "system-prompt-snapshot",
      content: "role",
      display: false,
      timestamp: 1,
    };
    await session.appendMessage(
      "snapshots",
      "bot-task-orphan",
      snapshot,
      undefined,
      "worker",
    );
    await session.appendMessage(
      "snapshots",
      "bot-task-real",
      snapshot,
      undefined,
      "worker",
    );
    expect([...session.readOwnerSessions("snapshots", "worker")]).toEqual([]);
    const user = { role: "user" as const, content: "work", timestamp: 2 };
    await session.appendMessage("snapshots", "bot-task-real", user);
    expect([...session.readOwnerSessions("snapshots", "worker")]).toEqual([
      { sessionId: "bot-task-real", message: snapshot },
      { sessionId: "bot-task-real", message: user },
    ]);
    expect(await session.loadMessages("snapshots", "bot-task-orphan")).toEqual([
      snapshot,
    ]);
  });

  it("ownerを初回作成時だけ設定しgroup別に順序よく読み出す", async () => {
    const user = { role: "user" as const, content: "first", timestamp: 1 };
    const reply = {
      role: "assistant" as const,
      content: "reply",
      timestamp: 2,
    };
    await session.appendMessage("owners", "b", user, undefined, "worker");
    await session.appendMessage(
      "owners",
      "b",
      reply as unknown as AgentMessage,
    );
    await session.appendMessage("owners", "a", user);
    await session.appendMessage(
      "owners",
      "z-old",
      { ...user, timestamp: 0 },
      undefined,
      "worker",
    );
    await session.appendMessage(
      "another-owners",
      "b",
      user,
      undefined,
      "worker",
    );
    expect([...session.readOwnerSessions("owners", "worker")]).toEqual([
      { sessionId: "z-old", message: { ...user, timestamp: 0 } },
      { sessionId: "b", message: user },
      { sessionId: "b", message: reply },
    ]);
    expect([...session.readOwnerSessions("owners", "main")]).toEqual([
      { sessionId: "a", message: user },
    ]);
    await session.renameSession("owners", "b", "c");
    expect([...session.readOwnerSessions("owners", "worker")]).toEqual([
      { sessionId: "z-old", message: { ...user, timestamp: 0 } },
      { sessionId: "c", message: user },
      { sessionId: "c", message: reply },
    ]);
    expect([...session.readOwnerSessions("another-owners", "worker")]).toEqual([
      { sessionId: "b", message: user },
    ]);
    expect([...session.readOwnerSessions("uncreated-owner", "main")]).toEqual(
      [],
    );
    const { existsSync } = await import("node:fs");
    expect(existsSync(path.join(root, "uncreated-owner"))).toBe(false);
  });

  it("session identityをtransactionでrenameしentryを維持する", async () => {
    await session.appendMessage("rename-group", "cron-temp", {
      role: "user",
      content: "hello",
      timestamp: 123,
    });
    await session.renameSession("rename-group", "cron-temp", "1234567890");

    await expect(
      session.loadMessages("rename-group", "cron-temp"),
    ).resolves.toEqual([]);
    await expect(
      session.loadMessages("rename-group", "1234567890"),
    ).resolves.toEqual([{ role: "user", content: "hello", timestamp: 123 }]);
  });

  it("rename先が存在する場合は上書きしない", async () => {
    await session.appendMessage("rename-conflict", "from", {
      role: "user",
      content: "from",
      timestamp: 1,
    });
    await session.appendMessage("rename-conflict", "to", {
      role: "user",
      content: "to",
      timestamp: 2,
    });
    await expect(
      session.renameSession("rename-conflict", "from", "to"),
    ).rejects.toThrow("リネーム先のセッションが既に存在します");
    await expect(
      session.loadMessages("rename-conflict", "from"),
    ).resolves.toHaveLength(1);
  });

  it("path traversalと未知のschema versionを拒否する", async () => {
    await expect(
      session.loadMessages("../../etc/passwd", "session"),
    ).rejects.toThrow("不正なグループ名");
    await expect(session.loadMessages("group", "../secret")).rejects.toThrow(
      "不正なセッションID",
    );

    const dir = path.join(root, "future");
    await mkdir(dir, { recursive: true });
    const db = new Database(path.join(dir, "sessions.sqlite"));
    db.pragma("user_version = 99");
    db.close();
    await expect(session.loadMessages("future", "session")).rejects.toThrow(
      "未対応のsession DB schema version",
    );
  });

  it("conversation pathはDBと論理session identityを表す", () => {
    expect(session.sessionConversationPath("group1", "session-a")).toBe(
      "data/sessions/group1/sessions.sqlite#session=session-a",
    );
  });
});
