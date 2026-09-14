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
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name).sort()).toEqual([
      "session_entries",
      "sessions",
      "sqlite_sequence",
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='session_entries_source_identity'",
        )
        .get(),
    ).toEqual({ name: "session_entries_source_identity" });
    expect(
      db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM session_entries WHERE session_id=? AND source_json IS NOT NULL AND json_extract(source_json, '$.kind')=? AND json_extract(source_json, '$.sourceId')=?",
        )
        .all("session", "discord", "message"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detail: expect.stringContaining(
            "USING INDEX session_entries_source_identity",
          ),
        }),
      ]),
    );
    expect(db.pragma("table_info(sessions)")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "mode" })]),
    );
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

  it("同じDiscord sourceの再送を二重保存しない", async () => {
    const source = {
      kind: "discord" as const,
      sourceId: "message-1",
      actorId: "user-1",
      messageType: 0 as const,
    };
    expect(await session.hasSessionSource("dedupe", "session-a", source)).toBe(
      false,
    );
    const first = await session.appendMessage(
      "dedupe",
      "session-a",
      { role: "user", content: "hello", timestamp: 1 },
      source,
    );
    const replay = await session.appendMessage(
      "dedupe",
      "session-a",
      { role: "user", content: "hello", timestamp: 1 },
      source,
    );

    expect(replay).toBe(first);
    expect(await session.hasSessionSource("dedupe", "session-a", source)).toBe(
      true,
    );
    expect(await session.loadMessages("dedupe", "session-a")).toHaveLength(1);
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
    0, 1, 2, 3, 4,
  ])("rechecks stale v%s under the migration write lock across concurrent connections", async (version) => {
    const group = `migration-v${version}`;
    await mkdir(path.join(root, group), { recursive: true });
    const db = new Database(path.join(root, group, "sessions.sqlite"));
    if (version >= 1) {
      db.exec(`
        CREATE TABLE sessions(id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'conversation', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE session_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE, sequence INTEGER NOT NULL, entry_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(session_id, sequence));
        PRAGMA user_version=1;
        INSERT INTO sessions VALUES('old', 'conversation', 1, 1);
        INSERT INTO session_entries(session_id, sequence, entry_type, payload_json, created_at) VALUES('old', 1, 'user', '{"role":"user","content":"old message","timestamp":1}', 1);
      `);
    }
    if (version >= 2) {
      db.exec(
        "ALTER TABLE session_entries ADD COLUMN source_json TEXT; CREATE INDEX session_entries_source ON session_entries(id) WHERE source_json IS NOT NULL; PRAGMA user_version=2;",
      );
    }
    if (version === 3) {
      db.exec(`ALTER TABLE session_entries ADD COLUMN execution_json TEXT;
        CREATE INDEX session_entries_execution ON session_entries(session_id, json_extract(execution_json, '$.jobId'), json_extract(execution_json, '$.fencingToken'), sequence) WHERE execution_json IS NOT NULL;
        PRAGMA user_version=3;`);
    }
    if (version === 4) db.pragma("user_version=4");
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
        expect(inspect.pragma("user_version", { simple: true })).toBe(5);
        expect(
          (
            inspect.pragma("table_info(session_entries)") as Array<{
              name: string;
            }>
          ).filter((column) =>
            ["source_json", "execution_json"].includes(column.name),
          ),
        ).toHaveLength(1);
        expect(
          inspect
            .prepare("SELECT COUNT(*) AS count FROM session_entries")
            .get(),
        ).toEqual({ count: version === 0 ? 2 : 3 });
        expect(
          inspect
            .prepare(
              "SELECT agent_initialized FROM sessions WHERE id='main-session'",
            )
            .get(),
        ).toEqual({ agent_initialized: 0 });
        if (version >= 1) {
          expect(
            inspect
              .prepare("SELECT agent_initialized FROM sessions WHERE id='old'")
              .get(),
          ).toEqual({ agent_initialized: 1 });
          expect(
            inspect
              .prepare(
                "SELECT source_json FROM session_entries WHERE session_id='old'",
              )
              .get(),
          ).toEqual({ source_json: null });
        }
      } finally {
        inspect.close();
      }
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      await worker.terminate();
    }
  }, 15_000);

  it("capture-first sessionのAgent初期化状態をraw trajectoryと独立に保存する", async () => {
    await session.appendMessage("mode-group", "session-a", {
      role: "user",
      content: "captured",
      timestamp: 123,
    });

    expect(
      await session.isSessionAgentInitialized("mode-group", "session-a"),
    ).toBe(false);
    await session.markSessionAgentInitialized("mode-group", "session-a");
    expect(
      await session.isSessionAgentInitialized("mode-group", "session-a"),
    ).toBe(true);
    expect(await session.loadMessages("mode-group", "session-a")).toEqual([
      { role: "user", content: "captured", timestamp: 123 },
    ]);
  });

  it("PR-era v5の不要なmode列だけを除去して履歴と初期化状態を維持する", async () => {
    await session.appendMessage("legacy-v5", "captured", {
      role: "user",
      content: "keep",
      timestamp: 1,
    });
    await session.markSessionAgentInitialized("legacy-v5", "initialized");
    const db = new Database(path.join(root, "legacy-v5", "sessions.sqlite"));
    db.exec(
      "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'capture-only' CHECK (mode IN ('normal', 'capture-only'))",
    );
    const entries = db.prepare("SELECT * FROM session_entries").all();
    db.close();

    expect(
      await session.isSessionAgentInitialized("legacy-v5", "captured"),
    ).toBe(false);
    expect(
      await session.isSessionAgentInitialized("legacy-v5", "initialized"),
    ).toBe(true);
    const inspect = dbFor("legacy-v5");
    expect(inspect.pragma("user_version", { simple: true })).toBe(5);
    expect(inspect.pragma("table_info(sessions)")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "mode" })]),
    );
    expect(inspect.prepare("SELECT * FROM session_entries").all()).toEqual(
      entries,
    );
    inspect.close();
  });

  it.each([
    { mode: true, initialized: false },
    { mode: true, initialized: true },
    { mode: false, initialized: false },
    { mode: false, initialized: true },
  ])("repairs earlier/partially migrated v5 shapes: %j", async ({
    mode,
    initialized,
  }) => {
    const group = `early-v5-${mode}-${initialized}`;
    const source = {
      kind: "discord" as const,
      sourceId: "message",
      actorId: "human",
      messageType: 0 as const,
    };
    await session.appendMessage(
      group,
      "old",
      { role: "user", content: "keep", timestamp: 1 },
      source,
    );
    const db = new Database(path.join(root, group, "sessions.sqlite"));
    const entries = db.prepare("SELECT * FROM session_entries").all();
    if (mode)
      db.exec(
        "ALTER TABLE sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'capture-only'))",
      );
    if (!initialized)
      db.exec("ALTER TABLE sessions DROP COLUMN agent_initialized");
    db.exec(
      "DROP INDEX session_entries_source_identity; CREATE INDEX session_entries_source ON session_entries(id) WHERE source_json IS NOT NULL",
    );
    db.close();

    // Missing historical state uses the legacy initialized default; an
    // existing explicit marker is preserved, and new sessions start fresh.
    expect(await session.isSessionAgentInitialized(group, "old")).toBe(
      !initialized,
    );
    expect(await session.hasSessionSource(group, "old", source)).toBe(true);
    const inspect = dbFor(group);
    expect(inspect.pragma("user_version", { simple: true })).toBe(5);
    expect(inspect.prepare("SELECT * FROM session_entries").all()).toEqual(
      entries,
    );
    expect(inspect.pragma("table_info(sessions)")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "mode" })]),
    );
    expect(
      inspect
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='session_entries_source_identity'",
        )
        .get(),
    ).toBeDefined();
    inspect.close();
    await session.appendMessage(group, "new", {
      role: "user",
      content: "new capture",
      timestamp: 2,
    });
    expect(await session.isSessionAgentInitialized(group, "new")).toBe(false);
    await session.markSessionAgentInitialized(group, "new");
    expect(await session.isSessionAgentInitialized(group, "new")).toBe(true);
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
