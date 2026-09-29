import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { convertSessionIdentity } from "./convert-issue568-session-identity.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "session-identity-"));
  roots.push(root);
  mkdirSync(path.join(root, "group"));
  const file = path.join(root, "group", "sessions.sqlite");
  const db = new Database(file);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'conversation',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main');
    CREATE INDEX sessions_agent_id_id ON sessions(agent_id,id);
    CREATE TABLE session_entries (id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
      sequence INTEGER NOT NULL, entry_type TEXT NOT NULL, payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, source_json TEXT, UNIQUE(session_id,sequence));
    CREATE INDEX session_entries_session_id_id ON session_entries(session_id,id);
    CREATE INDEX session_entries_source ON session_entries(id) WHERE source_json IS NOT NULL;
    INSERT INTO sessions VALUES ('shared','conversation',1,2,'main');
    INSERT INTO sessions VALUES ('bot-task','conversation',3,4,'worker');
    INSERT INTO session_entries VALUES (5,'shared',1,'user','{"role":"user","content":"regular"}',1,'{"kind":"discord","sourceId":"a"}');
    INSERT INTO session_entries VALUES (6,'shared',2,'assistant','{"role":"assistant","content":"cron"}',2,NULL);
    INSERT INTO session_entries VALUES (7,'bot-task',1,'user','{"role":"user","content":"bot"}',3,NULL);
    INSERT INTO session_entries VALUES (8,'shared',3,'user','{"role":"user","content":"deleted"}',4,NULL);
    DELETE FROM session_entries WHERE id=8;
    PRAGMA user_version=5;
  `);
  db.close();
  return { root, file };
}

it("rebuilds v5 without changing entry IDs, owners, or deleted ID high-water", () => {
  const { root, file } = fixture();
  convertSessionIdentity(root);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  expect(db.pragma("user_version", { simple: true })).toBe(6);
  expect(db.pragma("foreign_key_check")).toEqual([]);
  expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  expect(db.prepare("SELECT id,session_id,agent_id,sequence,payload_json,source_json FROM session_entries ORDER BY id").all()).toEqual([
    { id: 5, session_id: "shared", agent_id: "main", sequence: 1, payload_json: '{"role":"user","content":"regular"}', source_json: '{"kind":"discord","sourceId":"a"}' },
    { id: 6, session_id: "shared", agent_id: "main", sequence: 2, payload_json: '{"role":"assistant","content":"cron"}', source_json: null },
    { id: 7, session_id: "bot-task", agent_id: "worker", sequence: 1, payload_json: '{"role":"user","content":"bot"}', source_json: null },
  ]);
  expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='session_entries'").get()).toEqual({ seq: 8 });
  db.prepare("INSERT INTO sessions VALUES ('shared','conversation',1,1,'worker')").run();
  db.prepare("INSERT INTO session_entries(agent_id,session_id,sequence,entry_type,payload_json,created_at) VALUES ('worker','shared',1,'user','{}',1)").run();
  expect((db.prepare("SELECT max(id) AS id FROM session_entries").get() as { id: number }).id).toBeGreaterThan(8);
  db.prepare("UPDATE sessions SET id='new-id' WHERE id='shared' AND agent_id='main'").run();
  expect(db.prepare("SELECT session_id FROM session_entries WHERE id=5").get()).toEqual({ session_id: "new-id" });
  expect(db.prepare("SELECT session_id FROM session_entries WHERE agent_id='worker' AND session_id='shared'").get()).toEqual({ session_id: "shared" });
  expect(() => convertSessionIdentity(root)).toThrow("Expected schema v5");
  db.close();
});

it("preflights every group before the first write", () => {
  const { root, file } = fixture();
  mkdirSync(path.join(root, "invalid"));
  const second = new Database(path.join(root, "invalid", "sessions.sqlite"));
  second.pragma("user_version = 6");
  second.close();
  expect(() => convertSessionIdentity(root)).toThrow("Expected schema v5");
  const db = new Database(file);
  expect(db.pragma("user_version", { simple: true })).toBe(5);
  db.close();
});

it("rejects orphaned entries before changing any group", () => {
  const { root, file } = fixture();
  const db = new Database(file);
  db.pragma("foreign_keys = OFF");
  db.prepare("INSERT INTO session_entries(session_id,sequence,entry_type,payload_json,created_at) VALUES ('missing',1,'user','{}',1)").run();
  db.close();
  expect(() => convertSessionIdentity(root)).toThrow("Orphaned session entries");
});
