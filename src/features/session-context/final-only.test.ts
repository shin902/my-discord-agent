import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, expect, it, vi } from "vitest";
import { projectSessionContext, resolveSessionContext } from "./final-only.js";

const { readSessionEntries, readCommittedConversations } = vi.hoisted(() => ({
  readSessionEntries: vi.fn(),
  readCommittedConversations: vi.fn(),
}));
vi.mock("../../agent/session.js", () => ({ readSessionEntries }));
vi.mock("../../queue/repository.js", () => ({
  getQueueRepository: () => ({ readCommittedConversations }),
}));

function answer(
  stopReason: AssistantMessage["stopReason"] = "stop",
  text = "final",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    api: "openai-responses",
    provider: "test",
    model: "test",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
const user: AgentMessage = { role: "user", content: "input", timestamp: 1 };
const reference = { userEntryId: 1, assistantEntryId: 2 };

it.each([
  "stop",
  "length",
  "error",
  "aborted",
  "toolUse",
] as const)("accepts only publishable terminal text (%s)", (stopReason) => {
  const message = answer(stopReason);
  const entries = new Map<number, AgentMessage>([
    [1, user],
    [2, message],
  ]);
  expect(projectSessionContext(entries, [reference])).toEqual(
    stopReason === "stop" || stopReason === "length" ? [message] : [],
  );
});

it.each([
  answer("stop", ""),
  answer("stop", " \n"),
  { ...answer(), errorMessage: "failed" },
  {
    ...answer(),
    content: [
      { type: "text", text: "progress" },
      { type: "toolCall", id: "call", name: "read", arguments: {} },
    ],
  },
] as AssistantMessage[])("rejects an unusable adopted final without falling back to an intermediate stop (%j)", (message) => {
  const entries = new Map<number, AgentMessage>([
    [1, user],
    [2, message],
    [3, answer("stop", "intermediate")],
  ]);
  expect(projectSessionContext(entries, [reference])).toEqual([]);
});

it("uses exact references once, preserving final text while excluding raw events and missing entries", () => {
  const final = answer("stop", "unchanged final");
  const entries = new Map<number, AgentMessage>([
    [1, user],
    [2, final],
    [3, answer("stop", "progress")],
    [
      4,
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: [{ type: "text", text: "tool trace" }],
        isError: false,
        timestamp: 1,
      },
    ],
    [
      5,
      {
        role: "custom",
        customType: "steering-instruction",
        content: "old steer",
        display: false,
        timestamp: 1,
      },
    ],
  ]);
  expect(
    projectSessionContext(entries, [
      reference,
      reference,
      { userEntryId: 1, assistantEntryId: 999 },
      { userEntryId: 4, assistantEntryId: 3 },
    ]),
  ).toEqual([final]);
});

it("keeps long-session projected history below a tenth of raw history size", () => {
  const entries = new Map<number, AgentMessage>();
  const references = Array.from({ length: 30 }, (_, index) => {
    const userEntryId = index * 3 + 1;
    entries.set(userEntryId, user);
    entries.set(userEntryId + 1, answer("stop", "trace".repeat(4000)));
    entries.set(userEntryId + 2, answer("stop", `conclusion ${index}`));
    return { userEntryId, assistantEntryId: userEntryId + 2 };
  });
  const projected = projectSessionContext(entries, references);
  expect(projected).toHaveLength(30);
  expect(JSON.stringify(projected).length).toBeLessThan(
    JSON.stringify([...entries.values()]).length / 10,
  );
});

const input = {
  id: "run",
  groupName: "group",
  channelId: "child",
  sessionId: "child",
  routingChannelId: "parent",
  content: "current",
  timestamp: "2026-10-03",
  retries: 0,
};
beforeEach(() => {
  readSessionEntries.mockReset().mockReturnValue(new Map());
  readCommittedConversations.mockReset().mockReturnValue([reference]);
});

it.each([
  "main",
  "worker",
])("resolves queued cron policy using public references and owner %s", (agentId) => {
  expect(
    resolveSessionContext(
      { ...input, cronJobId: "cron", cronHistoryMode: "final-only" },
      agentId,
    ),
  ).toEqual([]);
  expect(readCommittedConversations).toHaveBeenCalledExactlyOnceWith("group", {
    publicOnly: true,
  });
  expect(readSessionEntries).toHaveBeenCalledExactlyOnceWith(
    "group",
    "child",
    agentId,
    [1, 2],
  );
});

it.each([
  {},
  { cronJobId: "cron", cronHistoryMode: "full" as const },
  { cronJobId: "cron", cronHistoryMode: "fresh" as const },
])("preserves unprojected history outside final-only cron (%j)", (override) => {
  expect(
    resolveSessionContext({ ...input, ...override }, "main"),
  ).toBeUndefined();
  expect(readCommittedConversations).not.toHaveBeenCalled();
  expect(readSessionEntries).not.toHaveBeenCalled();
});
