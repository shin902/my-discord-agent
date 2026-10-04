import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AgentExecutionOptions } from "../../sandbox/agent-execution.js";

const { execute, model, readCommittedConversations } = vi.hoisted(() => ({
  execute: vi.fn(),
  readCommittedConversations: vi.fn(),
  model: {
    id: "test",
    name: "Test",
    api: "openai-completions",
    provider: "test",
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  },
}));
vi.mock("../../sandbox/agent-execution.js", () => ({ runAgent: execute }));
vi.mock("../../agent/model.js", () => ({ resolveModel: async () => model }));
vi.mock("../../queue/repository.js", () => ({
  getQueueRepository: () => ({ readCommittedConversations }),
}));
vi.mock("../../skills/loader.js", async (original) => ({
  ...(await original<typeof import("../../skills/loader.js")>()),
  loadSkills: async () => [],
}));

const summary =
  "## Goal\nContinue the work\n## User Constraints\nDo not delete history\n## Current State\nIn progress\n## Important Facts\nID=12345\n## Decisions\nPreserve raw\n## Artifacts\nNone\n## Open Loops\nNone\n## Next Steps\nContinue\n## Recall\nSearch raw history";
const assistant = (text: string, timestamp = 2): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "openai-completions",
  provider: "test",
  model: "test",
  timestamp,
  stopReason: "stop",
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const user = (text: string, timestamp = 1): AgentMessage => ({
  role: "user",
  content: text,
  timestamp,
});
let root: string;
let previousSessionsDir: string | undefined;
let sessions: typeof import("../../agent/session.js");
let runner: typeof import("../../sandbox/agent-runner.js");
let compaction: typeof import("./compaction.js");
let finalOnly: typeof import("./final-only.js");
let groupIndex = 0;
let group: string;

beforeAll(async () => {
  previousSessionsDir = process.env.SESSIONS_DIR;
  root = await mkdtemp(join(tmpdir(), "context-compaction-"));
  process.env.SESSIONS_DIR = root;
  vi.resetModules();
  sessions = await import("../../agent/session.js");
  runner = await import("../../sandbox/agent-runner.js");
  compaction = await import("./compaction.js");
  finalOnly = await import("./final-only.js");
});
afterAll(async () => {
  if (previousSessionsDir === undefined) delete process.env.SESSIONS_DIR;
  else process.env.SESSIONS_DIR = previousSessionsDir;
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => {
  group = `group-${++groupIndex}`;
  model.contextWindow = 128_000;
  readCommittedConversations.mockReset().mockReturnValue([]);
  execute.mockReset();
  execute.mockImplementation(async (options: AgentExecutionOptions) => {
    const isSummary =
      typeof options.prompt === "string" &&
      options.prompt.startsWith("Summarize this conversation");
    const response = isSummary ? summary : "New response";
    const message = assistant(response);
    if (!isSummary && typeof options.prompt === "string")
      options.onEvent?.({ type: "message_end", message: user(options.prompt) });
    options.onEvent?.({ type: "message_end", message });
    return { response, terminalStopReason: "stop", agent: {} };
  });
});

async function seed(messages: AgentMessage[], owner = "main") {
  for (const message of messages)
    await sessions.appendMessage(group, "channel", message, owner);
}
async function run(
  action?: "clear" | "compact",
  settings: {
    allowContextReset?: boolean;
    operationId?: string;
    history?: AgentMessage[];
    enabled?: boolean;
    threshold?: number;
  } = {},
) {
  return runner.runAgentLoop(
    group,
    "channel",
    action ? "" : "New input",
    {
      model: { provider: "test", modelId: "test" },
      tools: [],
    },
    {
      agentId: "main",
      systemPromptSnapshotPresent: true,
      systemPromptSnapshotContent: "System prompt",
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    settings.history,
    {
      action,
      operationId: settings.operationId ?? "operation-1",
      allowContextReset: settings.allowContextReset ?? true,
    },
    {
      keepRecentTokens: 60,
      threshold: settings.threshold ?? 0.7,
      enabled: settings.enabled ?? true,
    },
  );
}

describe("non-destructive session context maintenance", () => {
  it("clear preserves raw entry IDs and adopted references, resets bootstrap, and is safe to retry", async () => {
    const source = {
      kind: "discord" as const,
      sourceId: "message",
      actorId: "human",
      messageType: 0 as const,
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    const userEntryId = await sessions.appendMessage(
      group,
      "channel",
      user("Old input"),
      "main",
      source,
    );
    const assistantEntryId = await sessions.appendMessage(
      group,
      "channel",
      assistant("Old output"),
      "main",
    );
    await seed([user("Other owner")], "worker");
    await run("clear");
    expect(execute).not.toHaveBeenCalled();
    const archive = compaction.contextArchiveId("channel", "operation-1");
    expect(await sessions.loadMessages(group, archive, "main")).toEqual([
      user("Old input"),
      assistant("Old output"),
    ]);
    expect([
      ...sessions.readConversations(group, [{ userEntryId, assistantEntryId }]),
    ]).toEqual([
      {
        sessionId: archive,
        source,
        user: user("Old input"),
        assistant: assistant("Old output"),
      },
    ]);
    await run("clear");
    await run(undefined, { operationId: "next" });
    const active = await sessions.loadMessages(group, "channel", "main");
    expect(
      active.some(
        (message) =>
          message.role === "custom" &&
          message.customType === "system-prompt-snapshot",
      ),
    ).toBe(true);
    expect(
      runner
        .defaultConvertToLlm(active)
        .some((message) => JSON.stringify(message).includes("Old input")),
    ).toBe(false);
    expect(await sessions.loadMessages(group, "channel", "worker")).toEqual([
      user("Other owner"),
    ]);
  });

  it("compact keeps complete recent tool exchanges, preserves searchable raw, and updates the previous summary without duplicating raw user entries", async () => {
    const history: AgentMessage[] = [
      user(`Old request ${"x".repeat(1200)}`),
      assistant("Old answer"),
      user("Recent request"),
      {
        ...assistant(""),
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "read",
            arguments: { path: "file" },
          },
        ],
        stopReason: "toolUse",
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: [{ type: "text", text: "file content" }],
        isError: false,
        timestamp: 3,
      },
      assistant("Recent answer"),
    ];
    await seed(history);
    await run("compact");
    const archive = compaction.contextArchiveId("channel", "operation-1");
    expect(await sessions.loadMessages(group, archive, "main")).toEqual(
      expect.arrayContaining(history),
    );
    const active = await sessions.loadMessages(group, "channel", "main");
    const projected = runner.defaultConvertToLlm(active);
    expect(
      projected.some((message) => JSON.stringify(message).includes("ID=12345")),
    ).toBe(true);
    expect(
      projected.filter((message) => message.role === "toolResult"),
    ).toHaveLength(1);
    expect(
      [...sessions.readOwnerSessions(group, "main")].filter(
        ({ message }) => message.role === "user",
      ),
    ).toHaveLength(2);
    expect(
      active.some(
        (message) =>
          message.role === "custom" &&
          message.customType === "session-time-anchor",
      ),
    ).toBe(true);
    await run("compact");
    expect(execute).toHaveBeenCalledTimes(1);
    await seed([
      user(`More history ${"y".repeat(1200)}`),
      assistant("More answer"),
    ]);
    await run("compact", { operationId: "second" });
    expect(execute.mock.calls[1][0].prompt).toContain("ID=12345");
    expect(
      (await sessions.loadMessages(group, "channel", "main")).filter(
        compaction.isCompactionMessage,
      ),
    ).toHaveLength(1);
  });

  it.each([
    1999, 2000, 2001, 100_000,
  ])("bounds each old tool result in the summary input without truncating raw history (%s characters)", async (length) => {
    const toolText = "log-content\n"
      .repeat(Math.ceil(length / 12))
      .slice(0, length);
    const toolResult: AgentMessage = {
      role: "toolResult",
      toolCallId: "old-call",
      toolName: "read",
      content: [
        { type: "text", text: toolText },
        {
          type: "image",
          data: "c2VjcmV0LWltYWdlLWJ5dGVz",
          mimeType: "image/png",
        },
      ],
      isError: false,
      timestamp: 3,
    };
    await seed([
      user("Never delete /workspace/exact-file; preserve ID=98765"),
      {
        ...assistant("Decision: keep the original file"),
        content: [
          { type: "text", text: "Decision: keep the original file" },
          {
            type: "toolCall",
            id: "old-call",
            name: "read",
            arguments: { path: "/workspace/exact-file" },
          },
        ],
        stopReason: "toolUse",
      } as AgentMessage,
      toolResult,
      assistant("Read completed"),
      user("Recent request"),
      assistant("Recent answer"),
    ]);
    await run("compact");
    const prompt = execute.mock.calls[0][0].prompt as string;
    expect(prompt).toContain(
      "[User]: Never delete /workspace/exact-file; preserve ID=98765",
    );
    expect(prompt).toContain("[Assistant]: Decision: keep the original file");
    expect(prompt).toContain(
      '[Assistant tool calls]: read({"path":"/workspace/exact-file"})',
    );
    expect(prompt).toContain(`[Tool result]: ${toolText.slice(0, 2000)}`);
    if (toolText.length > 2000)
      expect(prompt).toContain(
        `[... ${toolText.length - 2000} more characters truncated]`,
      );
    else expect(prompt).not.toContain("more characters truncated");
    expect(prompt.length).toBeLessThan(3000);
    for (const metadata of [
      '"usage"',
      '"cost"',
      '"model"',
      '"toolCallId"',
      '"mimeType"',
      "c2VjcmV0LWltYWdlLWJ5dGVz",
    ])
      expect(prompt).not.toContain(metadata);
    const archived = await sessions.loadMessages(
      group,
      compaction.contextArchiveId("channel", "operation-1"),
      "main",
    );
    expect(archived.find((message) => message.role === "toolResult")).toEqual(
      toolResult,
    );
  });

  it.each([
    "clear",
    "compact",
  ] as const)("rejects manual %s on protected sessions without altering history", async (action) => {
    await seed([user("Keep verbatim")]);
    await expect(run(action, { allowContextReset: false })).rejects.toThrow(
      "appendUserOnly",
    );
    expect(await sessions.loadMessages(group, "channel", "main")).toEqual([
      user("Keep verbatim"),
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { protected: true, disabled: false },
    { protected: false, disabled: true },
    { protected: false, disabled: false },
  ])("auto compact respects protection/opt-out and otherwise runs before the new input (%j)", async ({
    protected: protectedSession,
    disabled,
  }) => {
    await seed([
      user(`Old input ${"x".repeat(5000)}`),
      assistant("Old answer"),
      user("Recent"),
      assistant("Recent answer"),
    ]);
    model.contextWindow = 2000;
    const stderr = vi.spyOn(process.stderr, "write");
    await run(undefined, {
      allowContextReset: !protectedSession,
      enabled: !disabled,
    });
    const timing = stderr.mock.calls
      .map(([line]) => String(line))
      .filter(
        (line) =>
          line.startsWith("__DISCORD_EVENT__:") &&
          line.includes('"type":"agent_timing"'),
      )
      .map((line) => JSON.parse(line.slice("__DISCORD_EVENT__:".length)));
    stderr.mockRestore();
    expect(timing).toHaveLength(1);
    expect(timing[0].usage.totalTokens).toBe(
      !protectedSession && !disabled ? 30 : 15,
    );
    const shouldCompact = !protectedSession && !disabled;
    expect(execute).toHaveBeenCalledTimes(shouldCompact ? 2 : 1);
    const active = await sessions.loadMessages(group, "channel", "main");
    expect(active.some(compaction.isCompactionMessage)).toBe(shouldCompact);
    expect(
      active.some(
        (message) => message.role === "user" && message.content === "New input",
      ),
    ).toBe(true);
    if (shouldCompact)
      expect(
        execute.mock.calls[1][0].messages.some(compaction.isCompactionMessage),
      ).toBe(true);
  });

  it.each([
    { threshold: 0.5, shouldCompact: true },
    { threshold: 0.9, shouldCompact: false },
  ])("uses configurable thresholds and measured usage without retriggering on retained pre-compaction usage (%j)", async ({
    threshold,
    shouldCompact,
  }) => {
    const recent = assistant("Recent answer");
    if (recent.role !== "assistant")
      throw new Error("Invalid assistant fixture");
    recent.usage.input = 79_995;
    recent.usage.totalTokens = 80_000;
    await seed([
      user(`Old request ${"x".repeat(1200)}`),
      assistant("Old answer"),
      user("Recent"),
      recent,
    ]);
    await run(undefined, { threshold });
    expect(execute).toHaveBeenCalledTimes(shouldCompact ? 2 : 1);
    await run(undefined, { threshold, operationId: "next" });
    expect(execute).toHaveBeenCalledTimes(shouldCompact ? 3 : 2);
  });

  it("failed summary preserves the original trajectory", async () => {
    const history = [user(`Original ${"x".repeat(1200)}`), assistant("Answer")];
    await seed(history);
    execute.mockResolvedValue({
      response: "invalid summary",
      terminalStopReason: "stop",
      agent: {},
    });
    await expect(run("compact")).rejects.toThrow("template");
    expect(
      (await sessions.loadMessages(group, "channel", "main")).filter(
        (message) => message.role !== "custom",
      ),
    ).toEqual(history);
    expect(
      await sessions.loadMessages(
        group,
        compaction.contextArchiveId("channel", "operation-1"),
        "main",
      ),
    ).toEqual([]);
  });

  it("final-only compactions preserve recent public finals across repeated checkpoints without mixing private history", async () => {
    await seed([
      user(`Private tool trace ${"z".repeat(1200)}`),
      assistant("Raw private answer"),
    ]);
    const finals = [
      assistant(`Published answer ${"p".repeat(5000)}`),
      assistant("Recent published answer"),
    ];
    model.contextWindow = 2000;
    await run(undefined, { history: finals });
    expect(execute.mock.calls[0][0].prompt).toContain("Published answer");
    expect(execute.mock.calls[0][0].prompt).not.toContain("Private tool trace");
    await run(undefined, {
      operationId: "next",
      history: await finalOnly.resolveSessionContext(
        {
          id: "job",
          groupName: group,
          sessionId: "channel",
          channelId: "channel",
          content: "",
          timestamp: "2026-10-03",
          retries: 0,
          cronHistoryMode: "final-only",
        },
        "main",
      ),
    });
    const last = execute.mock.calls.at(-1)?.[0] as AgentExecutionOptions;
    expect(
      runner
        .defaultConvertToLlm(last.messages)
        .some((message) => JSON.stringify(message).includes("ID=12345")),
    ).toBe(true);
    const recentFinal = assistant("Latest published final");
    await run("compact", {
      operationId: "public-again",
      history: [
        ...last.messages,
        assistant(`New published answer ${"n".repeat(5000)}`),
        recentFinal,
      ],
    });
    const checkpoint = (
      await sessions.loadMessages(group, "channel", "main")
    ).find(compaction.isCompactionMessage);
    expect(checkpoint?.recentMessages).toEqual([recentFinal]);
    const repeatedSummary = execute.mock.calls.at(-1)?.[0].prompt;
    expect(repeatedSummary).toContain("Previous conversation checkpoint");
    expect(repeatedSummary).toContain("New published answer");
    expect(repeatedSummary).not.toContain("Latest published final");
    expect(repeatedSummary).not.toContain("Private tool trace");

    await run(undefined, { operationId: "ordinary", enabled: false });
    const ordinary = execute.mock.calls.at(-1)?.[0] as AgentExecutionOptions;
    expect(
      JSON.stringify(runner.defaultConvertToLlm(ordinary.messages)),
    ).toContain("Private tool trace");
    expect(
      JSON.stringify(runner.defaultConvertToLlm(ordinary.messages)),
    ).toContain("Raw private answer");
  });

  it("alternating full/public compactions retain the other projection through raw references, without mixing private summaries or restoring cleared context", async () => {
    const normal = execute.getMockImplementation();
    if (!normal) throw new Error("Missing inference fixture");
    execute.mockImplementation(async (options: AgentExecutionOptions) => {
      const result = await normal(options);
      if (
        typeof options.prompt === "string" &&
        options.prompt.startsWith("Summarize this conversation")
      )
        result.response = summary.replace(
          "Continue the work",
          options.prompt.includes("[User]")
            ? "Private checkpoint"
            : "Public checkpoint",
        );
      return result;
    });
    const userEntryId = await sessions.appendMessage(
      group,
      "channel",
      user(`Private request ${"x".repeat(1200)}`),
      "main",
    );
    const assistantEntryId = await sessions.appendMessage(
      group,
      "channel",
      assistant("Published conclusion"),
      "main",
    );
    await seed([user("Unpublished input"), assistant("Private progress")]);
    readCommittedConversations.mockReturnValue([
      { userEntryId, assistantEntryId },
    ]);
    const input = {
      id: "job",
      groupName: group,
      sessionId: "channel",
      channelId: "channel",
      content: "",
      timestamp: "2026-10-03",
      retries: 0,
    };
    await run("compact");
    const projected = await finalOnly.resolveSessionContext(
      { ...input, cronHistoryMode: "final-only" },
      "main",
    );
    await run(undefined, { operationId: "next", history: projected });
    const sent = JSON.stringify(
      runner.defaultConvertToLlm(execute.mock.calls.at(-1)?.[0].messages),
    );
    expect(sent).toContain("Published conclusion");
    expect(sent).not.toContain("Private request");
    expect(sent).not.toContain("Private progress");
    expect(sent).not.toContain("ID=12345");

    const nextUser = await sessions.appendMessage(
      group,
      "channel",
      user("New private constraint"),
      "main",
    );
    const nextFinal = await sessions.appendMessage(
      group,
      "channel",
      assistant(`New published conclusion ${"p".repeat(5000)}`),
      "main",
    );
    const recentUser = await sessions.appendMessage(
      group,
      "channel",
      user("Recent private request"),
      "main",
    );
    const recentFinal = await sessions.appendMessage(
      group,
      "channel",
      assistant("Recent published final"),
      "main",
    );
    readCommittedConversations.mockReturnValue([
      { userEntryId, assistantEntryId },
      { userEntryId: nextUser, assistantEntryId: nextFinal },
      { userEntryId: recentUser, assistantEntryId: recentFinal },
    ]);
    model.contextWindow = 2000;
    await run(undefined, {
      operationId: "public-compact",
      history: await finalOnly.resolveSessionContext(
        { ...input, cronHistoryMode: "final-only" },
        "main",
      ),
    });
    const publicSummaryPrompt = execute.mock.calls.at(-2)?.[0].prompt;
    expect(publicSummaryPrompt).toContain("Published conclusion");
    expect(publicSummaryPrompt).not.toContain("Private checkpoint");
    expect(publicSummaryPrompt).not.toContain("New private constraint");
    await run(undefined, { operationId: "ordinary", enabled: false });
    const fullContext = JSON.stringify(
      runner.defaultConvertToLlm(execute.mock.calls.at(-1)?.[0].messages),
    );
    expect(fullContext).toContain("Private checkpoint");
    expect(fullContext).toContain("New private constraint");
    expect(fullContext).not.toContain("Public checkpoint");
    await run("compact", { operationId: "full-again" });
    const publicContext = JSON.stringify(
      runner.defaultConvertToLlm(
        (await finalOnly.resolveSessionContext(
          { ...input, cronHistoryMode: "final-only" },
          "main",
        )) ?? [],
      ),
    );
    expect(publicContext).toContain("Public checkpoint");
    expect(publicContext).not.toContain("Private checkpoint");
    expect(publicContext).not.toContain("New private constraint");
    await run("clear", { operationId: "clear" });
    expect(
      await finalOnly.resolveSessionContext(
        { ...input, cronHistoryMode: "final-only" },
        "main",
      ),
    ).toEqual([]);
  });

  it("failed ordinary inference after auto compact retries from the already committed checkpoint", async () => {
    await seed([
      user(`Old input ${"x".repeat(5000)}`),
      assistant("Old answer"),
    ]);
    model.contextWindow = 2000;
    const normal = execute.getMockImplementation();
    if (!normal) throw new Error("Missing inference fixture");
    execute
      .mockImplementationOnce(normal)
      .mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(run()).rejects.toThrow("provider unavailable");
    await run();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[2][0].prompt).toBe("New input");
    expect(
      execute.mock.calls[2][0].messages.some(compaction.isCompactionMessage),
    ).toBe(true);
  });
});
