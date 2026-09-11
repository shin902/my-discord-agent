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
    expect(db.pragma("user_version", { simple: true })).toBe(2);
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

  it.each([
    0, 1,
  ])("rechecks stale v%s under the migration write lock across concurrent connections", async (version) => {
    const group = `migration-v${version}`;
    await mkdir(path.join(root, group), { recursive: true });
    const db = new Database(path.join(root, group, "sessions.sqlite"));
    if (version === 1) {
      db.exec(`
        CREATE TABLE sessions(id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'conversation', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE session_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE, sequence INTEGER NOT NULL, entry_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(session_id, sequence));
        PRAGMA user_version=1;
        INSERT INTO sessions VALUES('old', 'conversation', 1, 1);
        INSERT INTO session_entries(session_id, sequence, entry_type, payload_json, created_at) VALUES('old', 1, 'user', '{"role":"user","content":"old message","timestamp":1}', 1);
      `);
    }
    db.close();
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(
      new URL("./__fixtures__/session-migration.cjs", import.meta.url),
      {
        workerData: { root, group, version, gate: gate.buffer },
      },
    );
    const signal = AbortSignal.timeout(10_000);
    try {
      expect(await once(worker, "message", { signal })).toEqual([
        "stale-version-read",
      ]);
      await session.appendMessage(group, "main-session", {
        role: "user",
        content: "main message",
        timestamp: 2,
      });
      const finished = once(worker, "message", { signal });
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      expect(await finished).toEqual([
        { status: "appended", recheckedInTransaction: true },
      ]);
      const inspect = dbFor(group);
      try {
        expect(inspect.pragma("user_version", { simple: true })).toBe(2);
        expect(
          (
            inspect.pragma("table_info(session_entries)") as Array<{
              name: string;
            }>
          ).filter((column) => column.name === "source_json"),
        ).toHaveLength(1);
        expect(
          inspect
            .prepare("SELECT COUNT(*) AS count FROM session_entries")
            .get(),
        ).toEqual({ count: 2 + version });
        if (version === 1)
          expect(
            inspect
              .prepare(
                "SELECT source_json FROM session_entries WHERE session_id='old'",
              )
              .get(),
          ).toEqual({ source_json: null });
      } finally {
        inspect.close();
      }
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      await worker.terminate();
    }
  }, 15_000);

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
