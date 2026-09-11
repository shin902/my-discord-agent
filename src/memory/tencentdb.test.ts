import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "../utils/error.js";
import { TencentDbBackend } from "./tencentdb.js";
import type { MemoryCaptureTurn } from "./types.js";

const turn: MemoryCaptureTurn = {
  groupName: "main",
  sessionId: "session",
  source: {
    kind: "discord",
    sourceId: "message",
    actorId: "human",
    messageType: 0,
  },
  user: { content: "hello", timestamp: "2026-09-11T01:00:00.000Z" },
  assistant: { content: "hi", timestamp: "2026-09-11T01:00:01.000Z" },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("TencentDB backend adapter", () => {
  it("owns the HTTP schema and credential selector, without exporting internal provenance fields", async () => {
    vi.stubEnv("MEMORY_TEST_TOKEN", "private-token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ code: 0 })));
    await new TencentDbBackend({
      baseUrl: "https://memory.example/base/",
      serviceId: "service",
      teamId: "team",
      agentId: "agent",
      bearerTokenEnv: "MEMORY_TEST_TOKEN",
    }).exportTurn(turn);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://memory.example/base/v3/conversation/add",
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer private-token",
        "x-tdai-service-id": "service",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      session_id: "session",
      team_id: "team",
      agent_id: "agent",
      user_id: "human",
      messages: [
        { role: "user", ...turn.user },
        { role: "assistant", ...turn.assistant },
      ],
    });
  });

  it.each([
    "http://remote.example",
    "http://localhost:8420",
    "https://user:pass@example.test",
    "https://example.test?token=x",
    "https://example.test#fragment",
    "file:///etc/passwd",
  ])("rejects unsafe configured endpoint %s", (baseUrl) => {
    expect(() => new TencentDbBackend({ baseUrl })).toThrow(NonRetryableError);
  });
  it.each([
    "https://remote.example",
    "http://127.0.0.1:8420",
    "http://[::1]:8420",
  ])("accepts trusted transport %s", (baseUrl) => {
    expect(() => new TencentDbBackend({ baseUrl })).not.toThrow();
  });
  it("rejects invalid configured HTTP headers without exposing their values", async () => {
    vi.stubEnv("MEMORY_TEST_TOKEN", "secret\ninvalid-header");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const error = await new TencentDbBackend({
      bearerTokenEnv: "MEMORY_TEST_TOKEN",
    })
      .exportTurn(turn)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(String(error)).not.toContain("secret");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing credential before any network call", () => {
    vi.stubEnv("MEMORY_TEST_TOKEN", undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(
      () => new TencentDbBackend({ bearerTokenEnv: "MEMORY_TEST_TOKEN" }),
    ).toThrow(NonRetryableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [200, 408, true],
    [200, 429, true],
    [200, 503, true],
    [503, 0, true],
    [503, 400, true],
    [408, 400, true],
    [429, 400, true],
    [400, 0, false],
    [401, 503, false],
    [200, 400, false],
    [200, "secret-code", false],
    [200, undefined, false],
  ])("classifies HTTP %s / envelope %s retryable=%s without leaking remote error text", async (status, code, retryable) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code, message: "private-remote-error" }), {
        status,
      }),
    );
    const error = await new TencentDbBackend({})
      .exportTurn(turn)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof NonRetryableError).toBe(!retryable);
    expect(String(error)).not.toContain("private-remote-error");
    expect(String(error)).not.toContain("secret-code");
  });

  it("treats network and response-stream failure as transient, with sanitized errors", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("secret-network-detail"))
      .mockResolvedValueOnce({
        json: () => Promise.reject(new Error("stream broke")),
      } as unknown as Response);
    for (let index = 0; index < 2; index++) {
      const error = await new TencentDbBackend({})
        .exportTurn(turn)
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NonRetryableError);
      expect(String(error)).not.toContain("secret-network-detail");
      expect(String(error)).not.toContain("stream broke");
    }
  });

  it("times out response headers and body, aborts on lease loss, and never follows redirects", async () => {
    let redirectTargetRequests = 0;
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/redirect/")) {
        response.writeHead(302, { location: "/target" });
        response.end();
      } else if (request.url === "/target") {
        redirectTargetRequests++;
        response.end();
      } else if (request.url?.startsWith("/body/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"code":');
      }
      // /headers remains open until the client's timeout/abort.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const route of ["headers", "body"]) {
        const error = await new TencentDbBackend({
          baseUrl: `${base}/${route}`,
          timeoutMs: 30,
        })
          .exportTurn(turn)
          .catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(NonRetryableError);
      }
      const controller = new AbortController();
      const pending = new TencentDbBackend(
        { baseUrl: `${base}/headers`, timeoutMs: 1000 },
        controller.signal,
      ).exportTurn(turn);
      controller.abort();
      await expect(pending).rejects.toThrow(/transport/);
      await expect(
        new TencentDbBackend({ baseUrl: `${base}/redirect` }).exportTurn(turn),
      ).rejects.toThrow(NonRetryableError);
      expect(redirectTargetRequests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
