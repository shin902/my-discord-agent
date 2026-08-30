import {
  access,
  mkdir,
  mkdtemp,
  readdir,
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
  failingRenamePath: undefined as string | undefined,
  renameErrorCode: undefined as string | undefined,
  syncedPaths: new Set<string>(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (args[0] === fsMock.failingRenamePath) {
        const error = new Error(
          `injected rename failure: ${String(args[0])}`,
        ) as NodeJS.ErrnoException;
        error.code = fsMock.renameErrorCode;
        throw error;
      }
      await actual.rename(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              await target.sync();
              fsMock.syncedPaths.add(String(args[0]));
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

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
  session.closeSessionDatabasesForTests();
  delete process.env.SESSIONS_DIR;
  await rm(testRoot, { recursive: true, force: true });
});

function dbFor(group: string): Database.Database {
  return new Database(path.join(root, group, "sessions.sqlite"), {
    readonly: true,
  });
}

function markMigrated(group: string): void {
  const db = new Database(path.join(root, group, "sessions.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_store_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR REPLACE INTO session_store_metadata VALUES ('legacy_jsonl_imported', '1');
  `);
  db.close();
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

  async function findBackup(filename: string): Promise<string | undefined> {
    const backupRoot = path.join(root, "..", "session-jsonl-backup");
    async function walk(dir: string): Promise<string | undefined> {
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        () => [],
      );
      for (const entry of entries) {
        const candidate = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = await walk(candidate);
          if (found) return found;
        } else if (entry.name === filename) return candidate;
      }
      return undefined;
    }
    return walk(backupRoot);
  }

  it("起動migrationで全groupをimportしmarker付きDBを作ってJSONLを退避する", async () => {
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
    for (const group of groups) {
      const db = dbFor(group);
      expect(
        db
          .prepare(
            "SELECT value FROM session_store_metadata WHERE key='legacy_jsonl_imported'",
          )
          .get(),
      ).toEqual({ value: "1" });
      db.close();
    }
    const backup = await findBackup("session-0.jsonl");
    expect(backup).toContain(`${path.sep}legacy-a${path.sep}`);
    await expect(readFile(backup as string, "utf-8")).resolves.toContain(
      '"content":"legacy-a"',
    );
  });

  it("JSONLがないgroupにもmarker付きDBを作りstale tempを置換する", async () => {
    const group = "empty-migration";
    const dir = path.join(root, group);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "sessions.sqlite.migrating"), "stale");

    await session.migrateLegacySessionStores([group]);

    const db = dbFor(group);
    expect(
      db
        .prepare(
          "SELECT value FROM session_store_metadata WHERE key='legacy_jsonl_imported'",
        )
        .get(),
    ).toEqual({ value: "1" });
    db.close();
  });

  it("退避失敗はwarningにして原本を残し次回retryする", async () => {
    const group = "move-failure";
    const dir = path.join(root, group);
    await mkdir(dir, { recursive: true });
    const legacyPath = path.join(dir, "retained.jsonl");
    await writeFile(legacyPath, '{"role":"user","content":"retained"}\n');
    fsMock.failingRenamePath = legacyPath;
    fsMock.renameErrorCode = "EXDEV";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        session.migrateLegacySessionStores([group]),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("backupへ移動できませんでした"),
        expect.objectContaining({ code: "EXDEV" }),
      );
      await expect(access(legacyPath)).resolves.toBeUndefined();
      fsMock.failingRenamePath = undefined;
      await session.migrateLegacySessionStores([group]);
      await expect(access(legacyPath)).rejects.toThrow();
    } finally {
      fsMock.failingRenamePath = undefined;
      fsMock.renameErrorCode = undefined;
      warn.mockRestore();
    }
  });

  it("既存backupを上書きせずsourceを保持する", async () => {
    const group = "no-overwrite";
    const dir = path.join(root, group);
    await mkdir(dir, { recursive: true });
    const source = path.join(dir, "same.jsonl");
    await writeFile(source, '{"role":"user","content":"original"}\n');
    await session.migrateLegacySessionStores([group]);
    const backup = await findBackup("same.jsonl");
    await writeFile(source, '{"role":"user","content":"new"}\n');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await session.migrateLegacySessionStores([group]);
      await expect(readFile(backup as string, "utf-8")).resolves.toContain(
        "original",
      );
      await expect(readFile(source, "utf-8")).resolves.toContain("new");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("backupへ移動できませんでした"),
        expect.any(Error),
      );
    } finally {
      warn.mockRestore();
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
    await writeFile(brokenPath, '{"role":"user","content":"fixed"}\n');
    await expect(
      session.migrateLegacySessionStores(["batch-valid", "batch-broken"]),
    ).resolves.toBeUndefined();
    await expect(access(validPath)).rejects.toThrow();
    await expect(access(brokenPath)).rejects.toThrow();
  });

  it("markerなし既存SQLiteは失敗しJSONLを移動しない", async () => {
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

    await expect(session.migrateLegacySessionStores([group])).rejects.toThrow(
      "migration markerがありません",
    );

    await expect(access(legacyPath)).resolves.toBeUndefined();
    await expect(session.loadMessages(group, "old")).resolves.toHaveLength(2);
  });

  it("import済みmarkerがあればJSONL suffixを比較せず退避する", async () => {
    const group = "marker-suffix";
    await session.appendMessage(group, "old", {
      role: "user",
      content: "prefix",
      timestamp: 30,
    });
    markMigrated(group);
    const legacyPath = path.join(root, group, "old.jsonl");
    await writeFile(
      legacyPath,
      '{"role":"user","content":"prefix","timestamp":30}\n{"role":"assistant","content":"suffix","timestamp":31}\n',
    );

    await session.migrateLegacySessionStores([group]);

    await expect(session.loadMessages(group, "old")).resolves.toHaveLength(1);
    await expect(access(legacyPath)).rejects.toThrow();
  });

  it("marker付きDBではrename済みJSONLも内容推測せず退避する", async () => {
    const group = "renamed-legacy";
    await session.appendMessage(group, "temporary", {
      role: "user",
      content: "prefix",
      timestamp: 40,
    });
    await session.renameSession(group, "temporary", "item-thread");
    markMigrated(group);
    const legacyPath = path.join(root, group, "temporary.jsonl");
    await writeFile(
      legacyPath,
      '{"role":"user","content":"prefix","timestamp":40}\n{"role":"assistant","content":"after rename","timestamp":41}\n',
    );

    await session.migrateLegacySessionStores([group]);

    await expect(
      session.loadMessages(group, "item-thread"),
    ).resolves.toHaveLength(1);
    await expect(access(legacyPath)).rejects.toThrow();
  });

  it("marker付きDBでは曖昧なJSONLも比較せず退避する", async () => {
    const group = "ambiguous-legacy";
    for (const id of ["first", "second"]) {
      await session.appendMessage(group, id, {
        role: "user",
        content: "same prefix",
        timestamp: 50,
      });
    }
    markMigrated(group);
    const legacyPath = path.join(root, group, "old-name.jsonl");
    await writeFile(
      legacyPath,
      '{"role":"user","content":"same prefix","timestamp":50}\n',
    );

    await expect(
      session.migrateLegacySessionStores([group]),
    ).resolves.toBeUndefined();
    await expect(access(legacyPath)).rejects.toThrow();
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
