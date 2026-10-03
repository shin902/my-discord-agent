import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QueueRepository } from "../queue/repository.js";

let testRoot: string;
let root: string;
let session: typeof import("./session.js");
let defaultConvertToLlm: typeof import("../sandbox/agent-runner.js").defaultConvertToLlm;
let projectFinalResponseContext: typeof import("../sandbox/session-bootstrap.js").projectFinalResponseContext;

beforeAll(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
  root = path.join(testRoot, "sessions");
  process.env.SESSIONS_DIR = root;
  session = await import("./session.js");
  ({ defaultConvertToLlm } = await import("../sandbox/agent-runner.js"));
  ({ projectFinalResponseContext } = await import(
    "../sandbox/session-bootstrap.js"
  ));
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
      session.loadMessages("empty-group", "missing", "main"),
    ).resolves.toEqual([]);
    const db = dbFor("empty-group");
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    expect(
      (
        db.pragma("table_info(sessions)") as Array<{
          name: string;
          dflt_value: string | null;
        }>
      ).find(({ name }) => name === "agent_id")?.dflt_value,
    ).toBeNull();
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
    await session.appendMessage(
      "group1",
      "session-a",
      {
        role: "user",
        content: "hello",
        timestamp: 123,
      },
      "main",
    );
    await session.appendMessage(
      "group1",
      "session-a",
      {
        role: "assistant",
        reasoning: "internal",
        reasoning_content: "legacy",
        content: [
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "hi" },
        ],
        timestamp: 124,
      } as unknown as AgentMessage,
      "main",
    );

    const messages = await session.loadMessages("group1", "session-a", "main");
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
      "main",
      source,
    );
    const replays = await Promise.all(
      Array.from({ length: 5 }, () =>
        session.appendMessage(
          "dedupe",
          "session-a",
          { ...original, content: "edited", timestamp: 2 },
          "main",
          source,
        ),
      ),
    );
    expect(replays).toEqual(Array(5).fill(first));
    expect(await session.loadMessages("dedupe", "session-a", "main")).toEqual([
      original,
    ]);
    expect(
      await session.appendMessage(
        "dedupe",
        "session-b",
        original,
        "main",
        source,
      ),
    ).not.toBe(first);
  });

  it("並行appendを壊さず一意なsequenceとして保存する", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        session.appendMessage(
          "concurrent",
          "shared",
          {
            role: "user",
            content: `message-${index}`,
            timestamp: index,
          },
          "main",
        ),
      ),
    );
    const messages = await session.loadMessages("concurrent", "shared", "main");
    expect(messages).toHaveLength(20);
    expect(
      new Set(
        messages.map((message) => (message as { content?: unknown }).content),
      ).size,
    ).toBe(20);
  });

  it("concurrent fresh DB opens recheck v6 after the initialization lock", async () => {
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
      await session.appendMessage(
        group,
        "main-session",
        {
          role: "user",
          content: "main message",
          timestamp: 1,
        },
        "main",
      );
      const finished = once(worker, "message", { signal });
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      expect(await finished).toEqual([
        { status: "appended", recheckedInTransaction: true },
      ]);
      expect(
        await session.loadMessages(group, "worker-session", "main"),
      ).toHaveLength(1);
      const db = dbFor(group);
      expect(db.pragma("user_version", { simple: true })).toBe(6);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('sessions_agent_id_id','session_entries_session_id_id','session_entries_source')",
          )
          .all(),
      ).toEqual([]);
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
    await expect(session.loadMessages(group, "old", "main")).rejects.toThrow(
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
      "worker",
      undefined,
    );
    await session.appendMessage(
      "snapshots",
      "bot-task-real",
      snapshot,
      "worker",
      undefined,
    );
    expect([...session.readOwnerSessions("snapshots", "worker")]).toEqual([]);
    const user = { role: "user" as const, content: "work", timestamp: 2 };
    await session.appendMessage("snapshots", "bot-task-real", user, "worker");
    expect([...session.readOwnerSessions("snapshots", "worker")]).toEqual([
      { sessionId: "bot-task-real", message: snapshot },
      { sessionId: "bot-task-real", message: user },
    ]);
    expect(
      await session.loadMessages("snapshots", "bot-task-orphan", "worker"),
    ).toEqual([snapshot]);
  });

  it("ownerを維持しgroup別に順序よく読み出す", async () => {
    const user = { role: "user" as const, content: "first", timestamp: 1 };
    const reply = {
      role: "assistant" as const,
      content: "reply",
      timestamp: 2,
    };
    await session.appendMessage("owners", "b", user, "worker", undefined);
    await session.appendMessage(
      "owners",
      "b",
      reply as unknown as AgentMessage,
      "worker",
    );
    await session.appendMessage("owners", "a", user, "main");
    await session.appendMessage(
      "owners",
      "z-old",
      { ...user, timestamp: 0 },
      "worker",
      undefined,
    );
    await session.appendMessage(
      "another-owners",
      "b",
      user,
      "worker",
      undefined,
    );
    expect([...session.readOwnerSessions("owners", "worker")]).toEqual([
      { sessionId: "z-old", message: { ...user, timestamp: 0 } },
      { sessionId: "b", message: user },
      { sessionId: "b", message: reply },
    ]);
    expect([...session.readOwnerSessions("owners", "main")]).toEqual([
      { sessionId: "a", message: user },
    ]);
    await session.renameSession("owners", "b", "c", "worker");
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
    await session.appendMessage(
      "rename-group",
      "cron-temp",
      {
        role: "user",
        content: "hello",
        timestamp: 123,
      },
      "main",
    );
    await session.renameSession(
      "rename-group",
      "cron-temp",
      "1234567890",
      "main",
    );

    await expect(
      session.loadMessages("rename-group", "cron-temp", "main"),
    ).resolves.toEqual([]);
    await expect(
      session.loadMessages("rename-group", "1234567890", "main"),
    ).resolves.toEqual([{ role: "user", content: "hello", timestamp: 123 }]);
  });

  it("rename先が存在する場合は上書きしない", async () => {
    await session.appendMessage(
      "rename-conflict",
      "from",
      {
        role: "user",
        content: "from",
        timestamp: 1,
      },
      "main",
    );
    await session.appendMessage(
      "rename-conflict",
      "to",
      {
        role: "user",
        content: "to",
        timestamp: 2,
      },
      "main",
    );
    await expect(
      session.renameSession("rename-conflict", "from", "to", "main"),
    ).rejects.toThrow("リネーム先のセッションが既に存在します");
    await expect(
      session.loadMessages("rename-conflict", "from", "main"),
    ).resolves.toHaveLength(1);
  });

  it("同名session IDでもowner別にload/append/source dedup/renameを隔離する", async () => {
    const source = {
      kind: "discord" as const,
      sourceId: "shared-source",
      actorId: "human",
      messageType: 0 as const,
    };
    const user = { role: "user" as const, content: "same", timestamp: 10 };
    const mainId = await session.appendMessage(
      "two-owners",
      "same-id",
      user,
      "main",
      source,
    );
    const workerId = await session.appendMessage(
      "two-owners",
      "same-id",
      user,
      "worker",
      source,
    );
    expect(workerId).not.toBe(mainId);
    expect(
      await session.appendMessage(
        "two-owners",
        "same-id",
        user,
        "worker",
        source,
      ),
    ).toBe(workerId);
    expect(
      await session.appendMessage(
        "two-owners",
        "same-id",
        user,
        "main",
        source,
      ),
    ).toBe(mainId);
    const reply = {
      role: "assistant" as const,
      content: "only worker",
      timestamp: 11,
    };
    await session.appendMessage(
      "two-owners",
      "same-id",
      reply as unknown as AgentMessage,
      "worker",
    );
    expect(await session.loadMessages("two-owners", "same-id", "main")).toEqual(
      [user],
    );
    expect(
      await session.loadMessages("two-owners", "same-id", "worker"),
    ).toEqual([user, reply]);
    await session.renameSession("two-owners", "same-id", "renamed", "worker");
    expect(
      await session.loadMessages("two-owners", "same-id", "worker"),
    ).toEqual([]);
    expect(
      await session.loadMessages("two-owners", "renamed", "worker"),
    ).toEqual([user, reply]);
    expect(await session.loadMessages("two-owners", "same-id", "main")).toEqual(
      [user],
    );
    const db = dbFor("two-owners");
    expect(
      db
        .prepare(
          "SELECT id,agent_id,session_id FROM session_entries WHERE id=?",
        )
        .get(workerId),
    ).toEqual({ id: workerId, agent_id: "worker", session_id: "renamed" });
    db.close();
  });

  it("保存済みBot IDに記号があってもowner identityを維持する", async () => {
    const user = { role: "user" as const, content: "bot", timestamp: 1 };
    await session.appendMessage("bot-ids", "same", user, "worker.v1");
    expect(await session.loadMessages("bot-ids", "same", "worker.v1")).toEqual([
      user,
    ]);
    expect(await session.loadMessages("bot-ids", "same", "main")).toEqual([]);
  });

  it("path traversalと未知のschema versionを拒否する", async () => {
    await expect(
      session.loadMessages("../../etc/passwd", "session", "main"),
    ).rejects.toThrow("不正なグループ名");
    await expect(
      session.loadMessages("group", "../secret", "main"),
    ).rejects.toThrow("不正なセッションID");

    const dir = path.join(root, "future");
    await mkdir(dir, { recursive: true });
    const db = new Database(path.join(dir, "sessions.sqlite"));
    db.pragma("user_version = 99");
    db.close();
    await expect(
      session.loadMessages("future", "session", "main"),
    ).rejects.toThrow("未対応のsession DB schema version");
  });

  it("distinguishes owners of the same session and encodes Bot IDs", () => {
    const main = session.sessionConversationPath("group1", "session-a", "main");
    const bot = session.sessionConversationPath(
      "group1",
      "session-a",
      "research",
    );
    expect(bot).toBe(`${main}&agent=research`);
    const other = session.sessionConversationPath(
      "group1",
      "session-a",
      "research&agent=main/# 日本語",
    );
    expect(other).not.toBe(bot);
    const fragment = new URLSearchParams(other.split("#")[1]);
    expect([...fragment]).toEqual([
      ["session", "session-a"],
      ["agent", "research&agent=main/# 日本語"],
    ]);
    expect(() =>
      session.sessionConversationPath("group1", "session-a", ""),
    ).toThrow("Agent ID");
  });

  it("conversation pathはDBと論理session identityを表す", () => {
    expect(session.sessionConversationPath("group1", "session-a", "main")).toBe(
      "data/sessions/group1/sessions.sqlite#session=session-a",
    );
  });
});

describe("final-only session context", () => {
  function answer(
    text: string,
    stopReason: AssistantMessage["stopReason"] = "stop",
  ): AssistantMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: Date.now(),
    };
  }

  it("projects committed public finals across runs for Main and Bot while preserving raw traces and bootstrap", async () => {
    const group = "final-context";
    const repo = new QueueRepository(":memory:");
    try {
      for (const owner of ["main", "worker"]) {
        const bootstrap: AgentMessage[] = [
          {
            role: "custom",
            customType: "system-prompt-snapshot",
            content: `${owner} role`,
            display: false,
            timestamp: 1,
          },
          {
            role: "custom",
            customType: "context-bootstrap",
            content: "initial context",
            display: false,
            timestamp: 2,
          },
          {
            role: "custom",
            customType: "initial-agent-memory",
            content: "selected memory",
            display: false,
            timestamp: 3,
          },
        ];
        for (const message of bootstrap)
          await session.appendMessage(group, "shared", message, owner);
        const expected: AssistantMessage[] = [];
        for (let index = 0; index < 30; index++) {
          const { job } = repo.enqueue({
            groupName: group,
            channelId: "channel",
            routingChannelId: "channel",
            sessionId: "shared",
            ...(owner === "main" ? {} : { botId: owner }),
            content: "input",
            timestamp: new Date().toISOString(),
          });
          const claim = repo.claim("worker");
          if (!claim) throw new Error("missing claim");
          expect(claim.job.id).toBe(job.id);
          const userEntryId = await session.appendMessage(
            group,
            "shared",
            { role: "user", content: "old event", timestamp: 4 },
            owner,
          );
          // Intermediate stop messages must not become finals by inference.
          await session.appendMessage(
            group,
            "shared",
            answer(`progress ${"x".repeat(4000)}`),
            owner,
          );
          const toolCall = {
            ...answer("working", "toolUse"),
            content: [
              { type: "toolCall", id: "call", name: "read", arguments: {} },
            ],
          } as AssistantMessage;
          await session.appendMessage(group, "shared", toolCall, owner);
          await session.appendMessage(
            group,
            "shared",
            {
              role: "toolResult",
              toolCallId: "call",
              toolName: "read",
              content: [{ type: "text", text: `trace ${"x".repeat(4000)}` }],
              isError: false,
              timestamp: 5,
            },
            owner,
          );
          await session.appendMessage(
            group,
            "shared",
            {
              role: "custom",
              customType: "steering-instruction",
              content: "old steering",
              display: false,
              timestamp: 6,
            },
            owner,
          );
          const final = answer(`${owner} conclusion ${index}`);
          const assistantEntryId = await session.appendMessage(
            group,
            "shared",
            final,
            owner,
          );
          if (index === 0) {
            // Persisted but abandoned run: no commit, no final context.
            repo.deadLetter(job.id, claim.fencingToken, "cancelled");
          } else {
            const suppressDelivery = index === 1;
            repo.commitResult(job.id, claim.fencingToken, final.content, {
              conversation: { userEntryId, assistantEntryId },
              suppressDelivery,
            });
            if (!suppressDelivery) expected.push(final);
          }
        }
        // Legacy assistant and failed/cancelled outputs remain raw, never inferred.
        await session.appendMessage(
          group,
          "shared",
          answer("legacy final"),
          owner,
        );
        await session.appendMessage(
          group,
          "shared",
          answer("failed final", "error"),
          owner,
        );
        await session.appendMessage(
          group,
          "shared",
          answer("cancelled final", "aborted"),
          owner,
        );
        const raw = await session.loadMessages(group, "shared", owner);
        const finals = session.readSessionFinalResponses(
          group,
          "shared",
          owner,
          repo.readCommittedConversations(group, { publicOnly: true }),
        );
        expect(finals).toEqual(expected);
        const projected = projectFinalResponseContext(raw, finals);
        expect(projected).toEqual([...bootstrap, ...expected]);
        expect(
          JSON.stringify(defaultConvertToLlm(projected)).length,
        ).toBeLessThan(JSON.stringify(defaultConvertToLlm(raw)).length / 10);
        expect(await session.loadMessages(group, "shared", owner)).toEqual(raw);
      }
      expect(
        session.readSessionFinalResponses(
          group,
          "other",
          "main",
          repo.readCommittedConversations(group, { publicOnly: true }),
        ),
      ).toEqual([]);
    } finally {
      repo.close();
    }
  });

  it("requires exact same-owner/session user and assistant references and never falls back from an ineligible final", async () => {
    const group = "final-guards";
    const userEntryId = await session.appendMessage(
      group,
      "shared",
      { role: "user", content: "input", timestamp: 1 },
      "main",
    );
    const good = await session.appendMessage(
      group,
      "shared",
      answer("intermediate"),
      "main",
    );
    const ids: number[] = [];
    for (const message of [
      answer("error", "error"),
      answer("aborted", "aborted"),
      answer("tool", "toolUse"),
      answer(""),
      { ...answer("error message"), errorMessage: "failure" },
      {
        ...answer("tool call"),
        content: [
          { type: "toolCall", id: "call", name: "read", arguments: {} },
        ],
      } as AssistantMessage,
    ]) {
      ids.push(await session.appendMessage(group, "shared", message, "main"));
    }
    ids.push(
      await session.appendMessage(
        group,
        "other",
        answer("other session"),
        "main",
      ),
    );
    ids.push(
      await session.appendMessage(
        group,
        "shared",
        answer("other owner"),
        "worker",
      ),
    );
    ids.push(999999);
    expect(
      session.readSessionFinalResponses(
        group,
        "shared",
        "main",
        ids.map((assistantEntryId) => ({ userEntryId, assistantEntryId })),
      ),
    ).toEqual([]);
    expect(
      session.readSessionFinalResponses(group, "shared", "main", [
        { userEntryId, assistantEntryId: good },
        { userEntryId, assistantEntryId: good },
      ]),
    ).toEqual(
      [answer("intermediate")].map((message) => ({
        ...message,
        timestamp: expect.any(Number),
      })),
    );
  });
});
