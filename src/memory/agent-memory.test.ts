import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentMemoryConfigSchema,
  isAgentMemoryEligible,
} from "../config/agent-memory.js";
import { openRuntimeDb, QueueRepository } from "../queue/repository.js";
import {
  AgentMemoryClient,
  buildAgentMemorySubmission,
} from "./agent-memory.js";

const config = AgentMemoryConfigSchema.parse({
  enabled: true,
  baseUrl: "http://memory.test",
  serviceId: "space-1",
  bearerTokenEnv: "TDAI_TEST_TOKEN",
  teamId: "team-1",
  agentId: "agent-1",
  eligibleGroups: ["private"],
});

const normalMessage = {
  groupName: "private",
  userId: "discord-user-1",
};

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TDAI_TEST_TOKEN;
});

describe("Agent Memory shadow boundary", () => {
  it("requires explicit enabled eligible groups and normal-chat identity", () => {
    expect(isAgentMemoryEligible(config, normalMessage)).toBe(true);
    expect(
      isAgentMemoryEligible(config, { ...normalMessage, groupName: "public" }),
    ).toBe(false);
    expect(
      isAgentMemoryEligible(config, { ...normalMessage, cronJobId: "cron-1" }),
    ).toBe(false);
    expect(
      isAgentMemoryEligible(config, { ...normalMessage, botId: "coding" }),
    ).toBe(false);
    expect(
      isAgentMemoryEligible(config, { ...normalMessage, authorIsBot: true }),
    ).toBe(false);
    expect(isAgentMemoryEligible(config, { groupName: "private" })).toBe(false);
  });

  it("maps one completed user/assistant turn to the v3 L0 contract", () => {
    expect(
      buildAgentMemorySubmission({
        teamId: "team-1",
        agentId: "agent-1",
        userId: "discord-user-1",
        sessionId: "discord-session-1",
        userContent: "夜は通知しないで",
        assistantContent: "了解しました",
        userTimestamp: "2026-08-30T00:00:00.000Z",
        assistantTimestamp: "2026-08-30T00:00:01.000Z",
      }),
    ).toEqual({
      scope: {
        teamId: "team-1",
        agentId: "agent-1",
        userId: "discord-user-1",
        sessionId: "discord-session-1",
      },
      messages: [
        {
          role: "user",
          content: "夜は通知しないで",
          timestamp: "2026-08-30T00:00:00.000Z",
        },
        {
          role: "assistant",
          content: "了解しました",
          timestamp: "2026-08-30T00:00:01.000Z",
        },
      ],
    });
  });

  it("submits the documented endpoint and isolation fields", async () => {
    process.env.TDAI_TEST_TOKEN = "secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 0,
          message: "ok",
          request_id: "req-1",
          data: { accepted_ids: ["message-1"], total_count: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const submission = buildAgentMemorySubmission({
      teamId: "team-1",
      agentId: "agent-1",
      userId: "discord-user-1",
      sessionId: "discord-session-1",
      userContent: "hello",
      assistantContent: "hi",
      userTimestamp: "2026-08-30T00:00:00.000Z",
      assistantTimestamp: "2026-08-30T00:00:01.000Z",
    });

    await expect(
      new AgentMemoryClient(config).addConversation(submission),
    ).resolves.toEqual({
      requestId: "req-1",
      acceptedIds: ["message-1"],
      totalCount: 2,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://memory.test/v3/conversation/add",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer secret",
          "x-tdai-service-id": "space-1",
        }),
        body: JSON.stringify({
          session_id: "discord-session-1",
          team_id: "team-1",
          agent_id: "agent-1",
          user_id: "discord-user-1",
          messages: submission.messages,
        }),
      }),
    );
  });

  it("uses the runtime queue idempotency key for duplicate shadow jobs", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    const payload = {
      channelId: "channel-1",
      groupName: "private",
      sessionId: "memory-shadow:session-1",
      content: "memory-shadow",
      timestamp: "2026-08-30T00:00:00.000Z",
      memoryShadow: buildAgentMemorySubmission({
        teamId: "team-1",
        agentId: "agent-1",
        userId: "discord-user-1",
        sessionId: "session-1",
        userContent: "hello",
        assistantContent: "hi",
        userTimestamp: "2026-08-30T00:00:00.000Z",
        assistantTimestamp: "2026-08-30T00:00:01.000Z",
      }),
    };
    const first = repository.enqueue(payload, {
      idempotencyKey: "agent-memory-shadow:source-1",
    });
    const duplicate = repository.enqueue(payload, {
      idempotencyKey: "agent-memory-shadow:source-1",
    });
    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);
  });

  it("surfaces service failure for the independent retryable job boundary", async () => {
    process.env.TDAI_TEST_TOKEN = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 503, message: "unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const submission = buildAgentMemorySubmission({
      teamId: "team-1",
      agentId: "agent-1",
      userId: "discord-user-1",
      sessionId: "discord-session-1",
      userContent: "hello",
      assistantContent: "hi",
      userTimestamp: "2026-08-30T00:00:00.000Z",
      assistantTimestamp: "2026-08-30T00:00:01.000Z",
    });
    await expect(
      new AgentMemoryClient(config).addConversation(submission),
    ).rejects.toThrow("conversation/add failed (503)");
  });
});
