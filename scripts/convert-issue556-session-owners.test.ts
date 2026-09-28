import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { convertSessionOwners } from "./convert-issue556-session-owners.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "issue556-"));
  roots.push(root);
  const sessions = path.join(root, "sessions");
  mkdirSync(sessions);
  const runtime = path.join(root, "runtime.sqlite");
  const db = new Database(runtime);
  db.exec("CREATE TABLE bot_task_sessions(group_name TEXT, session_id TEXT, bot_id TEXT)");
  db.close();
  return { runtime, sessions };
}

function group(root: string, name: string, version = 4) {
  const dir = path.join(root, name);
  mkdirSync(dir);
  const file = path.join(dir, "sessions.sqlite");
  const db = new Database(file);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'conversation', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE session_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE, sequence INTEGER NOT NULL, entry_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, source_json TEXT, UNIQUE(session_id, sequence));`);
  db.pragma(`user_version = ${version}`);
  return db;
}

function entry(db: Database.Database, id: string, source: string | null = null) {
  db.prepare("INSERT INTO sessions VALUES (?, 'conversation', 1, 1)").run(id);
  db.prepare("INSERT INTO session_entries(session_id,sequence,entry_type,payload_json,created_at,source_json) VALUES (?,1,'user',?,1,?)").run(id, JSON.stringify({ role: "user", content: id, timestamp: 1 }), source);
}

it("registered owners persist across groups; only orphan UUID sessions and their entries are removed", () => {
  const { runtime, sessions } = fixture();
  const a = group(sessions, "a");
  const b = group(sessions, "b");
  const orphan = "bot-task-12345678-1234-4123-8123-123456789abc";
  const registered = "bot-task-12345678-1234-4123-8123-123456789abd";
  const second = "bot-task-12345678-1234-4123-8123-123456789abe";
  entry(a, second);
  for (const db of [a, b]) {
    entry(db, registered, '{"kind":"discord"}');
    entry(db, "ordinary");
    db.close();
  }
  const extra = group(sessions, "c");
  entry(extra, orphan);
  entry(extra, "bot-task-almost");
  extra.close();
  const r = new Database(runtime);
  r.prepare("INSERT INTO bot_task_sessions VALUES (?,?,?)").run("a", registered, "removed-from-registry");
  r.prepare("INSERT INTO bot_task_sessions VALUES (?,?,?)").run("b", registered, "second-bot");
  r.prepare("INSERT INTO bot_task_sessions VALUES (?,?,?)").run("a", second, "another-bot");
  r.close();
  convertSessionOwners(runtime, sessions);
  for (const [name, owner] of [["a", "removed-from-registry"], ["b", "second-bot"]]) {
    const db = new Database(path.join(sessions, name, "sessions.sqlite"), { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(db.prepare("SELECT agent_id FROM sessions WHERE id=?").get(registered)).toEqual({ agent_id: owner });
    expect(db.prepare("SELECT agent_id FROM sessions WHERE id='ordinary'").get()).toEqual({ agent_id: "main" });
    expect(db.prepare("SELECT id,source_json FROM session_entries WHERE session_id=?").get(registered)).toEqual({ id: name === "a" ? 2 : 1, source_json: '{"kind":"discord"}' });
    db.close();
  }
  const aResult = new Database(path.join(sessions, "a", "sessions.sqlite"), { readonly: true });
  expect(aResult.prepare("SELECT agent_id FROM sessions WHERE id=?").get(second)).toEqual({ agent_id: "another-bot" });
  aResult.close();
  const db = new Database(path.join(sessions, "c", "sessions.sqlite"), { readonly: true });
  expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id=?").get(orphan)).toEqual({ n: 0 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM session_entries WHERE session_id=?").get(orphan)).toEqual({ n: 0 });
  expect(db.prepare("SELECT agent_id FROM sessions WHERE id='bot-task-almost'").get()).toEqual({ agent_id: "main" });
  db.close();
});

it("preflight rejects a legacy Bot ID main before modifying any group", () => {
  const { runtime, sessions } = fixture();
  const db = group(sessions, "a");
  entry(db, "legacy-task");
  db.close();
  const r = new Database(runtime);
  r.prepare("INSERT INTO bot_task_sessions VALUES (?,?,?)").run("a", "legacy-task", "main");
  r.close();
  expect(() => convertSessionOwners(runtime, sessions)).toThrow("Reserved Bot ID main");
  const inspect = new Database(path.join(sessions, "a", "sessions.sqlite"), { readonly: true });
  expect(inspect.pragma("user_version", { simple: true })).toBe(4);
  expect(inspect.pragma("table_info(sessions)")).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "agent_id" })]));
  inspect.close();
});

it("preflight refuses any non-v4 group before modifying other groups", () => {
  const { runtime, sessions } = fixture();
  group(sessions, "a").close();
  group(sessions, "b", 1).close();
  expect(() => convertSessionOwners(runtime, sessions)).toThrow("Expected schema v4");
  const db = new Database(path.join(sessions, "a", "sessions.sqlite"), { readonly: true });
  expect(db.pragma("user_version", { simple: true })).toBe(4);
  db.close();
});
