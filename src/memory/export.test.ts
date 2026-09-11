import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { SessionExecution, SessionSource } from "../agent/source.js";
import { MemoryExportLedger } from "./export-ledger.js";

const root = await mkdtemp(join(tmpdir(), "memory-trajectory-"));
vi.stubEnv("SESSIONS_DIR", root);
const session = await import("../agent/session.js");
const { readCaptureTurns, exportBatch } = await import("./export.js");
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const attempts = new Map<string, SessionExecution>();
let attemptId = 0;
const isCommitted = () => true;
async function append(
  group: string,
  sessionId: string,
  message: AgentMessage,
  origin?: SessionSource,
): Promise<void> {
  const key = `${group}/${sessionId}`;
  if (message.role === "user")
    attempts.set(key, { jobId: `job-${++attemptId}`, fencingToken: 1 });
  await session.appendMessage(
    group,
    sessionId,
    message,
    origin,
    attempts.get(key),
  );
}
const source = (id: string): SessionSource => ({
  kind: "discord",
  sourceId: id,
  actorId: "human",
  messageType: 0,
});
const user = (content = "question"): AgentMessage => ({
  role: "user",
  content,
  timestamp: 1000,
});
const assistant = (
  content: string,
  stopReason = "stop",
  extra = {},
): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text: content }],
    timestamp: 2000,
    stopReason,
    ...extra,
  }) as AgentMessage;

describe("canonical source trajectories", () => {
  it("reconstructs only completed nonempty finals from sourced users and respects boundaries", async () => {
    const group = "turns";
    const add = (msg: AgentMessage, origin?: SessionSource) =>
      append(group, "chat", msg, origin);
    await add(user("history without provenance"));
    await add(assistant("not exported"));
    await add(user("first"), source("first"));
    await add(assistant("tool preamble", "toolUse"));
    await add(assistant("first answer"));
    await add(assistant("last successful answer"));
    await add(user("missing assistant"), source("missing"));
    await add(user("reply"), { ...source("reply"), messageType: 19 });
    await add(assistant("failed", "error", { errorMessage: "failure" }));
    await add(assistant("aborted", "aborted"));
    await add(assistant("reply answer"));
    for (const [id, response] of [
      ["empty", assistant(" \n")],
      ["error", assistant("partial", "error")],
      ["aborted", assistant("partial", "aborted")],
      ["length", assistant("partial", "length")],
      ["tool", assistant("preamble", "toolUse")],
      ["error-field", assistant("bad", "stop", { errorMessage: "failure" })],
    ] as const) {
      await add(user(id), source(id));
      await add(response);
    }
    await add(user(""), source("empty-user"));
    await add(assistant("answer to empty"));
    await add(user("unfinished human"), source("before-cron"));
    await add(user("cron prompt"));
    await add(assistant("cron output, not a human answer"));
    await add(user("next real question"), source("next"));
    await add(assistant("next answer"));
    await add(user("still running"), source("running"));
    const turns = [...readCaptureTurns(group, isCommitted)];
    expect(
      turns.map((turn) => [turn.source.sourceId, turn.assistant.content]),
    ).toEqual([
      ["first", "last successful answer"],
      ["reply", "reply answer"],
      ["next", "next answer"],
    ]);
    expect(turns[1]).toMatchObject({
      source: { messageType: 19 },
      user: { timestamp: "1970-01-01T00:00:01.000Z" },
    });
    await add(assistant("now finished"));
    expect(
      [...readCaptureTurns(group, isCommitted)].at(-1)?.source.sourceId,
    ).toBe("running");
  });

  it("fails closed without an execution identity or committed runtime outcome", async () => {
    await session.appendMessage(
      "unconfirmed",
      "chat",
      user(),
      source("legacy"),
    );
    await session.appendMessage(
      "unconfirmed",
      "chat",
      assistant("legacy response"),
    );
    const check = vi.fn().mockReturnValue(true);
    expect([...readCaptureTurns("unconfirmed", check)]).toEqual([]);
    expect(check).not.toHaveBeenCalled();
    await append("unconfirmed", "chat", user(), source("current"));
    await append("unconfirmed", "chat", assistant("current response"));
    expect([...readCaptureTurns("unconfirmed", () => false)]).toEqual([]);
    expect(
      [...readCaptureTurns("unconfirmed", check)].map(
        (turn) => turn.source.sourceId,
      ),
    ).toEqual(["current"]);
    expect(check).toHaveBeenCalledWith(attempts.get("unconfirmed/chat"));
  });

  it.each([
    "length",
    "error",
    "aborted",
  ])("does not substitute an earlier stop when the final assistant ends with %s", async (stopReason) => {
    const group = `final-${stopReason}`;
    await append(group, "chat", user(), source("one"));
    await append(group, "chat", assistant("interim stop"));
    await append(group, "chat", assistant("actual final", stopReason));
    expect([...readCaptureTurns(group, isCommitted)]).toEqual([]);
  });

  it("matches the final response of an attempt that includes follow-up prompts", async () => {
    await append("follow-up", "chat", user(), source("one"));
    await append("follow-up", "chat", assistant("interim stop"));
    const execution = attempts.get("follow-up/chat");
    await session.appendMessage(
      "follow-up",
      "chat",
      user("follow-up within the same run"),
      undefined,
      execution,
    );
    await session.appendMessage(
      "follow-up",
      "chat",
      assistant("committed final"),
      undefined,
      execution,
    );
    expect(
      [...readCaptureTurns("follow-up", isCommitted)][0].assistant.content,
    ).toBe("committed final");
  });

  it("checks committed success before reading the response snapshot", async () => {
    await append("commit-race", "chat", user(), source("one"));
    await append("commit-race", "chat", assistant("interim stop"));
    const db = new Database(join(root, "commit-race", "sessions.sqlite"));
    try {
      const check = () => {
        // Simulate the source worker completing immediately before authority is observed.
        db.prepare(`INSERT INTO session_entries(session_id, sequence, entry_type, payload_json, created_at, execution_json)
          SELECT 'chat', MAX(sequence)+1, 'assistant', ?, 2000, ? FROM session_entries WHERE session_id='chat'`).run(
          JSON.stringify(assistant("committed final")),
          JSON.stringify(attempts.get("commit-race/chat")),
        );
        return true;
      };
      expect(
        [...readCaptureTurns("commit-race", check)][0].assistant.content,
      ).toBe("committed final");
    } finally {
      db.close();
    }
  });

  it("does not migrate or infer committed attempts from schema v2 provenance", async () => {
    await session.appendMessage("v2", "chat", user(), source("old"));
    await session.appendMessage("v2", "chat", assistant("old response"));
    const filename = join(root, "v2", "sessions.sqlite");
    const db = new Database(filename);
    db.exec(
      "DROP INDEX session_entries_execution; ALTER TABLE session_entries DROP COLUMN execution_json; PRAGMA user_version=2;",
    );
    db.close();
    const before = await readFile(filename);
    expect([...readCaptureTurns("v2", isCommitted)]).toEqual([]);
    expect(await readFile(filename)).toEqual(before);
    await append("v2", "new", user(), source("new"));
    await append("v2", "new", assistant("new response"));
    expect(
      [...readCaptureTurns("v2", isCommitted)].map(
        (turn) => turn.source.sourceId,
      ),
    ).toEqual(["new"]);
  });

  it("exports the original Discord creation time after delayed processing, retaining canonical processing time", async () => {
    const createdAt = "2026-09-01T01:00:00.000Z";
    const processedAt = Date.parse("2026-09-04T09:00:00.000Z");
    await append(
      "backfill",
      "chat",
      {
        ...user("delayed Discord message"),
        timestamp: processedAt,
      },
      { ...source("backfilled"), createdAt },
    );
    await append("backfill", "chat", {
      ...assistant("delayed answer"),
      timestamp: processedAt + 1000,
    });
    const messages = await session.loadMessages("backfill", "chat");
    expect(messages[0].timestamp).toBe(processedAt);
    const backend = { exportTurn: vi.fn().mockResolvedValue(undefined) };
    const ledger = new MemoryExportLedger(":memory:");
    try {
      await exportBatch(
        "backend",
        ["backfill"],
        50,
        backend,
        ledger,
        isCommitted,
      );
      expect(backend.exportTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          source: expect.objectContaining({ createdAt }),
          user: { content: "delayed Discord message", timestamp: createdAt },
          assistant: {
            content: "delayed answer",
            timestamp: "2026-09-04T09:00:01.000Z",
          },
        }),
      );
    } finally {
      ledger.close();
    }
  });

  it("reads without modifying the session DB, and does not create missing groups", async () => {
    await append("readonly", "chat", user(), source("one"));
    await append("readonly", "chat", assistant("answer"));
    const filename = join(root, "readonly", "sessions.sqlite");
    const before = await readFile(filename);
    expect([...readCaptureTurns("readonly", isCommitted)]).toHaveLength(1);
    expect(await readFile(filename)).toEqual(before);
    expect([...readCaptureTurns("absent", isCommitted)]).toEqual([]);
    expect(existsSync(join(root, "absent"))).toBe(false);
    expect(await session.loadMessages("readonly", "chat")).toEqual([
      user(),
      assistant("answer"),
    ]);
  });

  it("upgrades v1 on the normal write path without inventing provenance for old entries", async () => {
    await mkdir(join(root, "legacy"));
    const filename = join(root, "legacy", "sessions.sqlite");
    const db = new Database(filename);
    db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,kind TEXT NOT NULL DEFAULT 'conversation',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE session_entries(id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,sequence INTEGER NOT NULL,entry_type TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(session_id,sequence));
      PRAGMA user_version=1; INSERT INTO sessions VALUES('old','conversation',1,1);`);
    db.prepare(
      "INSERT INTO session_entries(session_id,sequence,entry_type,payload_json,created_at) VALUES('old',1,'user',?,1)",
    ).run(JSON.stringify(user("old")));
    db.close();
    const before = await readFile(filename);
    expect([...readCaptureTurns("legacy", isCommitted)]).toEqual([]);
    expect(await readFile(filename)).toEqual(before);
    await append("legacy", "new", user(), source("new"));
    await append("legacy", "new", assistant("new answer"));
    expect(
      [...readCaptureTurns("legacy", isCommitted)].map(
        (turn) => turn.source.sourceId,
      ),
    ).toEqual(["new"]);
    const inspect = new Database(filename, { readonly: true });
    expect(inspect.pragma("user_version", { simple: true })).toBe(3);
    expect(
      inspect
        .prepare(
          "SELECT source_json FROM session_entries WHERE session_id='old'",
        )
        .get(),
    ).toEqual({ source_json: null });
    inspect.close();
  });

  it("stores provenance only on user entries and preserves it through session rename", async () => {
    await expect(
      append("rename", "a", assistant("bad"), source("invalid")),
    ).rejects.toThrow(/user entry/);
    await append("rename", "a", user(), source("one"));
    await append("rename", "a", assistant("answer"));
    await session.renameSession("rename", "a", "b");
    expect([...readCaptureTurns("rename", isCommitted)][0]).toMatchObject({
      sessionId: "b",
      source: source("one"),
    });
  });

  it("keeps backend and group marker namespaces independent with a success-only schema", async () => {
    for (const group of ["groupa", "groupb"]) {
      await append(group, "chat", user(), source("same-id"));
      await append(group, "chat", assistant("answer"));
    }
    const filename = join(root, "ledger.sqlite");
    const ledger = new MemoryExportLedger(filename);
    const backend = { exportTurn: vi.fn().mockResolvedValue(undefined) };
    try {
      await exportBatch(
        "backend-a",
        ["groupa", "groupb"],
        50,
        backend,
        ledger,
        isCommitted,
      );
      await exportBatch(
        "backend-a",
        ["groupa", "groupb"],
        50,
        backend,
        ledger,
        isCommitted,
      );
      expect(backend.exportTurn).toHaveBeenCalledTimes(2);
      await exportBatch(
        "backend-b",
        ["groupa", "groupb"],
        50,
        backend,
        ledger,
        isCommitted,
      );
      expect(backend.exportTurn).toHaveBeenCalledTimes(4);
    } finally {
      ledger.close();
    }
    const db = new Database(filename, { readonly: true });
    expect(
      (db.pragma("table_info(exports)") as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    ).toEqual([
      "backend_id",
      "group_name",
      "source_kind",
      "source_id",
      "exported_at",
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM exports").get()).toEqual({
      count: 4,
    });
    db.close();
  });

  it("stops before remote I/O on queue lease cancellation without marking an export", async () => {
    await append("cancelled", "chat", user(), source("one"));
    await append("cancelled", "chat", assistant("answer"));
    const ledger = new MemoryExportLedger(":memory:");
    const backend = { exportTurn: vi.fn() };
    try {
      await expect(
        exportBatch(
          "backend",
          ["cancelled"],
          50,
          backend,
          ledger,
          isCommitted,
          AbortSignal.abort(),
        ),
      ).rejects.toThrow();
      expect(backend.exportTurn).not.toHaveBeenCalled();
      expect(
        ledger.has(
          "backend",
          [...readCaptureTurns("cancelled", isCommitted)][0],
        ),
      ).toBe(false);
    } finally {
      ledger.close();
    }
  });
});
