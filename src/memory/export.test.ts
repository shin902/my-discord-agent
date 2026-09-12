import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ConversationEntries } from "../agent/conversation.js";
import type { SessionSource } from "../agent/source.js";
import { MemoryExportLedger } from "./export-ledger.js";

const root = await mkdtemp(join(tmpdir(), "memory-conversations-"));
vi.stubEnv("SESSIONS_DIR", root);
const session = await import("../agent/session.js");
const { readCaptureTurns, exportBatch } = await import("./export.js");
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
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
const assistant = (content = "answer"): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text: content }],
    timestamp: 2000,
    stopReason: "stop",
  }) as AgentMessage;
async function appendTurn(
  group: string,
  id = "one",
  origin: SessionSource = source(id),
): Promise<ConversationEntries> {
  const userEntryId = await session.appendMessage(
    group,
    "chat",
    user(),
    origin,
  );
  const assistantEntryId = await session.appendMessage(
    group,
    "chat",
    assistant(),
  );
  return { userEntryId, assistantEntryId };
}

describe("committed conversation export", () => {
  it("reads only the adopted pair, ignoring adjacent stops, follow-up prompts and later writes", async () => {
    const group = "exact";
    const userEntryId = await session.appendMessage(
      group,
      "chat",
      user("original"),
      source("one"),
    );
    await session.appendMessage(group, "chat", assistant("interim stop"));
    await session.appendMessage(
      group,
      "chat",
      user("follow-up in the same run"),
    );
    const assistantEntryId = await session.appendMessage(
      group,
      "chat",
      assistant("adopted final"),
    );
    await session.appendMessage(
      group,
      "chat",
      user("abandoned retry"),
      source("one"),
    );
    await session.appendMessage(group, "chat", assistant("stale response"));
    expect([...readCaptureTurns(group, [])]).toEqual([]);
    const turns = [
      ...readCaptureTurns(group, [{ userEntryId, assistantEntryId }]),
    ];
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      user: { content: "original" },
      assistant: { content: "adopted final" },
      source: source("one"),
    });
  });

  it("skips unsourced, missing and cross-session references without substituting nearby entries", async () => {
    const group = "unresolvable";
    const pair = await appendTurn(group);
    const otherId = await session.appendMessage(
      group,
      "other",
      assistant("wrong session"),
    );
    const unsourcedUser = await session.appendMessage(
      group,
      "chat",
      user("cron prompt"),
    );
    const unsourcedAnswer = await session.appendMessage(
      group,
      "chat",
      assistant("cron answer"),
    );
    const references = [
      { ...pair, userEntryId: 999 },
      { ...pair, assistantEntryId: 999 },
      { ...pair, assistantEntryId: otherId },
      { userEntryId: unsourcedUser, assistantEntryId: unsourcedAnswer },
      pair,
    ];
    expect([...readCaptureTurns(group, references)]).toHaveLength(1);
    const db = new Database(join(root, group, "sessions.sqlite"));
    db.prepare("DELETE FROM session_entries WHERE id=?").run(
      pair.assistantEntryId,
    );
    db.close();
    expect([...readCaptureTurns(group, references)]).toEqual([]);
  });

  it.each([
    "",
    " \n",
  ])("does not export blank canonical text %j", async (content) => {
    const group = `blank-${content.length}`;
    const userEntryId = await session.appendMessage(
      group,
      "chat",
      user(content),
      source("one"),
    );
    const assistantEntryId = await session.appendMessage(
      group,
      "chat",
      assistant(),
    );
    expect([
      ...readCaptureTurns(group, [{ userEntryId, assistantEntryId }]),
    ]).toEqual([]);
  });

  it("uses the original Discord time while retaining canonical processing time and stripping thinking", async () => {
    const group = "backfill";
    const createdAt = "2026-09-01T01:00:00.000Z";
    const processedAt = Date.parse("2026-09-04T09:00:00.000Z");
    const userEntryId = await session.appendMessage(
      group,
      "chat",
      { ...user(), timestamp: processedAt },
      { ...source("one"), messageType: 19, createdAt },
    );
    const assistantEntryId = await session.appendMessage(group, "chat", {
      ...assistant(),
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "answer" },
      ],
      timestamp: processedAt + 1000,
    } as AgentMessage);
    expect((await session.loadMessages(group, "chat"))[0].timestamp).toBe(
      processedAt,
    );
    const turn = [
      ...readCaptureTurns(group, [{ userEntryId, assistantEntryId }]),
    ][0];
    expect(turn).toMatchObject({
      source: { createdAt, messageType: 19 },
      user: { content: "question", timestamp: createdAt },
      assistant: { content: "answer", timestamp: "2026-09-04T09:00:01.000Z" },
    });
  });

  it("reads without modifying the DB, creates no missing DB and follows session rename by stable IDs", async () => {
    const pair = await appendTurn("readonly");
    const filename = join(root, "readonly", "sessions.sqlite");
    const before = await readFile(filename);
    expect([...readCaptureTurns("readonly", [pair])][0].user.timestamp).toBe(
      "1970-01-01T00:00:01.000Z",
    );
    expect(await readFile(filename)).toEqual(before);
    expect([...readCaptureTurns("absent", [pair])]).toEqual([]);
    expect(existsSync(join(root, "absent"))).toBe(false);
    await session.renameSession("readonly", "chat", "materialized");
    expect([...readCaptureTurns("readonly", [pair])][0].sessionId).toBe(
      "materialized",
    );
    await expect(
      session.appendMessage(
        "readonly",
        "materialized",
        assistant(),
        source("bad"),
      ),
    ).rejects.toThrow(/user entry/);
  });

  it.each([
    1, 2, 3,
  ])("does not migrate or infer old v%s history on export; migration preserves entry IDs", async (version) => {
    const group = `legacy-${version}`;
    const pair = await appendTurn(group);
    const filename = join(root, group, "sessions.sqlite");
    const db = new Database(filename);
    if (version === 1)
      db.exec(
        "DROP INDEX session_entries_source; ALTER TABLE session_entries DROP COLUMN source_json;",
      );
    if (version === 3)
      db.exec(`ALTER TABLE session_entries ADD COLUMN execution_json TEXT;
      CREATE INDEX session_entries_execution ON session_entries(session_id, json_extract(execution_json, '$.jobId'), json_extract(execution_json, '$.fencingToken'), sequence) WHERE execution_json IS NOT NULL;
      UPDATE session_entries SET execution_json='{"jobId":"old","fencingToken":1}';`);
    db.pragma(`user_version = ${version}`);
    db.close();
    const before = await readFile(filename);
    expect([...readCaptureTurns(group, [pair])]).toEqual([]);
    expect(await readFile(filename)).toEqual(before);
    const newPair = await appendTurn(group, "new");
    expect(newPair.userEntryId).toBeGreaterThan(pair.assistantEntryId);
    expect([...readCaptureTurns(group, [newPair])]).toHaveLength(1);
    // Old text is not automatically promoted to a reference during migration.
    expect([...readCaptureTurns(group, [])]).toEqual([]);
    const inspect = new Database(filename, { readonly: true });
    expect(inspect.pragma("user_version", { simple: true })).toBe(4);
    expect(
      inspect
        .prepare("SELECT id FROM session_entries WHERE id=?")
        .get(pair.userEntryId),
    ).toEqual({ id: pair.userEntryId });
    expect(
      (
        inspect.pragma("table_info(session_entries)") as Array<{ name: string }>
      ).map((column) => column.name),
    ).not.toContain("execution_json");
    inspect.close();
  });

  it("keeps backend/group namespaces independent with the unchanged success-only ledger schema", async () => {
    const references = new Map<string, ConversationEntries[]>();
    for (const group of ["groupa", "groupb"])
      references.set(group, [await appendTurn(group, "same-id")]);
    const readCommitted = (group: string) => references.get(group) ?? [];
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
        readCommitted,
      );
      await exportBatch(
        "backend-a",
        ["groupa", "groupb"],
        50,
        backend,
        ledger,
        readCommitted,
      );
      expect(backend.exportTurn).toHaveBeenCalledTimes(2);
      await exportBatch(
        "backend-b",
        ["groupa", "groupb"],
        50,
        backend,
        ledger,
        readCommitted,
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

  it("stops before remote I/O on lease cancellation without marking success", async () => {
    const pair = await appendTurn("cancelled");
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
          () => [pair],
          AbortSignal.abort(),
        ),
      ).rejects.toThrow();
      expect(backend.exportTurn).not.toHaveBeenCalled();
      expect(
        ledger.has("backend", [...readCaptureTurns("cancelled", [pair])][0]),
      ).toBe(false);
    } finally {
      ledger.close();
    }
  });
});
