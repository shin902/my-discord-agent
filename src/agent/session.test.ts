import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  events: [] as string[],
  failingUnlinkPath: undefined as string | undefined,
  syncedPaths: new Set<string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (target: Parameters<typeof actual.unlink>[0]) => {
      if (target === fsMock.failingUnlinkPath) {
        throw new Error(`injected unlink failure: ${String(target)}`);
      }
      await actual.unlink(target);
      fsMock.events.push(`unlink:${String(target)}`);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              await target.sync();
              fsMock.syncedPaths.add(String(args[0]));
              fsMock.events.push(`sync:${String(args[0])}`);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

let root: string;
let session: typeof import("./session.js");

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
  process.env.SESSIONS_DIR = root;
  session = await import("./session.js");
});

afterAll(async () => {
  session.closeSessionDatabasesForTests();
  delete process.env.SESSIONS_DIR;
  await rm(root, { recursive: true, force: true });
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
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sessions" }),
        expect.objectContaining({ name: "session_entries" }),
      ]),
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

  it("起動migrationで全groupをimportしてからlegacy JSONLを一括削除する", async () => {
    const groups = ["legacy-a", "legacy-b"];
    for (const [index, group] of groups.entries()) {
      const dir = path.join(root, group);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, `session-${index}.jsonl`),
        `${JSON.stringify({ role: "user", content: group, timestamp: index + 10 })}\n`,
      );
    }

    await session.migrateLegacySessionStores(groups);

    await expect(
      session.loadMessages("legacy-a", "session-0"),
    ).resolves.toEqual([{ role: "user", content: "legacy-a", timestamp: 10 }]);
    await expect(
      session.loadMessages("legacy-b", "session-1"),
    ).resolves.toEqual([{ role: "user", content: "legacy-b", timestamp: 11 }]);
    await expect(
      access(path.join(root, "legacy-a", "session-0.jsonl")),
    ).rejects.toThrow();
    await expect(
      access(path.join(root, "legacy-b", "session-1.jsonl")),
    ).rejects.toThrow();
  });

  it("一部のJSONL削除が失敗しても削除成功したdirectoryをsyncしてから失敗する", async () => {
    const syncedDir = path.join(root, "unlink-success");
    const failedDir = path.join(root, "unlink-failure");
    await mkdir(syncedDir, { recursive: true });
    await mkdir(failedDir, { recursive: true });
    const deletedPath = path.join(syncedDir, "deleted.jsonl");
    const retainedPath = path.join(failedDir, "retained.jsonl");
    await writeFile(deletedPath, '{"role":"user","content":"deleted"}\n');
    await writeFile(retainedPath, '{"role":"user","content":"retained"}\n');
    fsMock.failingUnlinkPath = retainedPath;
    fsMock.events.length = 0;
    fsMock.syncedPaths.clear();

    try {
      await session
        .migrateLegacySessionStores(["unlink-success", "unlink-failure"])
        .catch((error: unknown) => {
          fsMock.events.push("rejected");
          throw error;
        })
        .then(
          () => expect.fail("migration should reject"),
          (error: unknown) =>
            expect(error).toHaveProperty(
              "message",
              expect.stringContaining("injected unlink failure"),
            ),
        );
      const deletionStart = fsMock.events.indexOf(`unlink:${deletedPath}`);
      expect(deletionStart).toBeGreaterThanOrEqual(0);
      expect(fsMock.events.slice(deletionStart)).toEqual([
        `unlink:${deletedPath}`,
        `sync:${syncedDir}`,
        "rejected",
      ]);
      expect(fsMock.syncedPaths).toContain(syncedDir);
      await expect(access(deletedPath)).rejects.toThrow();
      await expect(access(retainedPath)).resolves.toBeUndefined();
    } finally {
      fsMock.failingUnlinkPath = undefined;
    }
  });

  it("いずれかのJSONLが壊れていれば全groupのlegacy原本を残す", async () => {
    const validDir = path.join(root, "batch-valid");
    const brokenDir = path.join(root, "batch-broken");
    await mkdir(validDir, { recursive: true });
    await mkdir(brokenDir, { recursive: true });
    const validPath = path.join(validDir, "valid.jsonl");
    const brokenPath = path.join(brokenDir, "bad.jsonl");
    await writeFile(validPath, '{"role":"user","content":"ok"}\n');
    await writeFile(brokenPath, '{"role":"user","content":"ok"}\nnot-json\n');

    await expect(
      session.migrateLegacySessionStores(["batch-valid", "batch-broken"]),
    ).rejects.toThrow(/bad\.jsonl:2/);
    await expect(readFile(validPath, "utf-8")).resolves.toContain("ok");
    await expect(readFile(brokenPath, "utf-8")).resolves.toContain("not-json");
  });

  it("既存SQLiteがlegacy JSONLと一致すれば検証後に原本を削除する", async () => {
    const group = "existing-db";
    await session.appendMessage(group, "old", {
      role: "user",
      content: "already imported",
      timestamp: 20,
    });
    await session.appendMessage(group, "old", {
      role: "user",
      content: "new SQLite-only entry",
      timestamp: 21,
    });
    const legacyPath = path.join(root, group, "old.jsonl");
    await writeFile(
      legacyPath,
      '{"role":"user","content":"already imported","timestamp":20}\n',
    );

    await session.migrateLegacySessionStores([group]);

    await expect(access(legacyPath)).rejects.toThrow();
    await expect(session.loadMessages(group, "old")).resolves.toHaveLength(2);
  });

  it("import済みmarkerがあってもJSONLの追記suffixをSQLiteへ反映する", async () => {
    const group = "marker-suffix";
    await session.appendMessage(group, "old", {
      role: "user",
      content: "prefix",
      timestamp: 30,
    });
    const db = new Database(path.join(root, group, "sessions.sqlite"));
    db.exec(`
      CREATE TABLE session_store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO session_store_metadata VALUES ('legacy_jsonl_imported', '1');
    `);
    db.close();
    const legacyPath = path.join(root, group, "old.jsonl");
    await writeFile(
      legacyPath,
      '{"role":"user","content":"prefix","timestamp":30}\n{"role":"assistant","content":"suffix","timestamp":31}\n',
    );

    await session.migrateLegacySessionStores([group]);

    await expect(session.loadMessages(group, "old")).resolves.toHaveLength(2);
    await expect(access(legacyPath)).rejects.toThrow();
  });

  it("rename済みsessionとの対応が一意ならJSONL suffixを新identityへ反映する", async () => {
    const group = "renamed-legacy";
    await session.appendMessage(group, "temporary", {
      role: "user",
      content: "prefix",
      timestamp: 40,
    });
    await session.renameSession(group, "temporary", "item-thread");
    const legacyPath = path.join(root, group, "temporary.jsonl");
    await writeFile(
      legacyPath,
      '{"role":"user","content":"prefix","timestamp":40}\n{"role":"assistant","content":"after rename","timestamp":41}\n',
    );

    await session.migrateLegacySessionStores([group]);

    await expect(
      session.loadMessages(group, "item-thread"),
    ).resolves.toHaveLength(2);
    await expect(access(legacyPath)).rejects.toThrow();
  });

  it("rename済みsessionとの対応が曖昧ならJSONLを保持して失敗する", async () => {
    const group = "ambiguous-legacy";
    for (const id of ["first", "second"]) {
      await session.appendMessage(group, id, {
        role: "user",
        content: "same prefix",
        timestamp: 50,
      });
    }
    const legacyPath = path.join(root, group, "old-name.jsonl");
    await writeFile(
      legacyPath,
      '{"role":"user","content":"same prefix","timestamp":50}\n',
    );

    await expect(session.migrateLegacySessionStores([group])).rejects.toThrow(
      "対応を一意に確認できません",
    );
    await expect(access(legacyPath)).resolves.toBeUndefined();
  });

  it("path traversalと未知のschema versionを拒否する", async () => {
    await expect(
      session.loadMessages("../../etc/passwd", "session"),
    ).rejects.toThrow("不正なグループ名");
    await expect(session.loadMessages("group", "../secret")).rejects.toThrow(
      "不正なセッションID",
    );

    const { mkdir } = await import("node:fs/promises");
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
