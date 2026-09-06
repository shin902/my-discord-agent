import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentMemoryConfigSchema,
  isAgentMemoryEligible,
} from "../config/agent-memory.js";
import { openRuntimeDb, QueueRepository } from "../queue/repository.js";
import {
  AgentMemoryClient,
  AgentMemoryHttpError,
  buildAgentMemorySubmission,
} from "./agent-memory.js";

const config = AgentMemoryConfigSchema.parse({
  enabled: true,
  baseUrl: "http://127.0.0.1:8420",
  serviceId: "space-1",
  bearerTokenEnv: "TDAI_TEST_TOKEN",
  teamId: "team-1",
  agentId: "agent-1",
  eligibleGroups: ["private"],
});

const normalMessage = {
  groupName: "private",
  messageType: 0,
  userId: "discord-user-1",
};

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TDAI_TEST_TOKEN;
});

describe("Agent Memory shadow boundary", () => {
  it("defaults to unauthenticated local MemoryCore", () => {
    const parsed = AgentMemoryConfigSchema.parse({});
    expect(parsed).toMatchObject({
      enabled: false,
      baseUrl: "http://127.0.0.1:8420",
    });
    expect(parsed).not.toHaveProperty("bearerTokenEnv");
  });

  it("accepts only loopback HTTP and HTTPS URLs without query or fragment", () => {
    for (const baseUrl of [
      "http://127.0.0.1:8420",
      "http://[::1]:8420",
      "https://memory.example.test",
    ]) {
      expect(() => AgentMemoryConfigSchema.parse({ baseUrl })).not.toThrow();
    }
    for (const baseUrl of [
      "ftp://memory",
      "http://memory.example.test",
      "http://user:pass@memory",
      "http://127.0.0.1:8420?token=secret",
      "http://127.0.0.1:8420#fragment",
      "http://localhost:8420",
    ]) {
      expect(() => AgentMemoryConfigSchema.parse({ baseUrl })).toThrow();
    }
  });

  it("classifies permanent HTTP failures separately from retryable failures", () => {
    expect(new AgentMemoryHttpError("bad request", 400).retryable).toBe(false);
    expect(new AgentMemoryHttpError("timeout", 408).retryable).toBe(true);
    expect(new AgentMemoryHttpError("rate limited", 429).retryable).toBe(true);
    expect(new AgentMemoryHttpError("server error", 503).retryable).toBe(true);
    expect(new AgentMemoryHttpError("network").retryable).toBe(true);
  });

  it("rejects a redirect response without following it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://unexpected.example/collect" },
      }),
    );
    process.env.TDAI_TEST_TOKEN = "secret";
    const submission = buildAgentMemorySubmission({
      teamId: "team-1",
      agentId: "agent-1",
      userId: "discord-user-1",
      sessionId: "session-1",
      userContent: "hello",
      assistantContent: "hi",
      userTimestamp: "2026-08-30T00:00:00.000Z",
      assistantTimestamp: "2026-08-30T00:00:01.000Z",
    });

    await expect(
      new AgentMemoryClient(config).addConversation(submission),
    ).rejects.toMatchObject({ status: 302, retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });

    fetchMock.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {
        cause: new Error("unexpected redirect"),
      }),
    );
    await expect(
      new AgentMemoryClient(config).addConversation(submission),
    ).rejects.toMatchObject({ retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires explicit enabled eligible groups and conversational message types", () => {
    expect(isAgentMemoryEligible(config, normalMessage)).toBe(true);
    expect(
      isAgentMemoryEligible(config, { ...normalMessage, messageType: 19 }),
    ).toBe(true);
    expect(
      isAgentMemoryEligible(config, { ...normalMessage, messageType: 20 }),
    ).toBe(false);
    expect(
      isAgentMemoryEligible(config, {
        ...normalMessage,
        messageType: undefined,
      }),
    ).toBe(true);
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

  it("submits to a local unauthenticated MemoryCore without Authorization", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 0, data: { total_count: 2 } }), {
        status: 200,
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
      new AgentMemoryClient(
        AgentMemoryConfigSchema.parse({
          ...config,
          bearerTokenEnv: undefined,
        }),
      ).addConversation(submission),
    ).resolves.toMatchObject({ totalCount: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8420/v3/conversation/add",
      expect.objectContaining({
        headers: expect.not.objectContaining({
          authorization: expect.anything(),
        }),
      }),
    );
  });

  it("submits the documented endpoint and isolation fields when authentication is configured", async () => {
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
      "http://127.0.0.1:8420/v3/conversation/add",
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

  it("classifies a transient envelope code on an HTTP 200 response as retryable", async () => {
    process.env.TDAI_TEST_TOKEN = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: 503, message: "busy" }), {
        status: 200,
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
    ).rejects.toMatchObject({ retryable: true, status: 200 });
  });

  it("does not expose an echoed response message in the error", async () => {
    process.env.TDAI_TEST_TOKEN = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 400,
          message: "do-not-persist-this-secret",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
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

    const result = await new AgentMemoryClient(config)
      .addConversation(submission)
      .then(
        () => null,
        (value: unknown) => value,
      );
    expect(result).toBeInstanceOf(Error);
    const error = result as Error;
    expect(error.message).not.toContain("do-not-persist-this-secret");
    expect(error.message).toContain("400");
    expect(error.message).toContain("code 400");
  });

  it("ignores nonnumeric envelope codes without leaking their value", async () => {
    process.env.TDAI_TEST_TOKEN = "secret";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "503", message: "secret" }), {
        status: 200,
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

    const result = await new AgentMemoryClient(config)
      .addConversation(submission)
      .then(
        () => null,
        (value: unknown) => value,
      );
    expect(result).toBeInstanceOf(AgentMemoryHttpError);
    const error = result as AgentMemoryHttpError;
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("code unknown");
    expect(error.message).not.toContain("secret");
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
    ).rejects.toThrow("conversation/add failed (503, code 503)");
  });
});
