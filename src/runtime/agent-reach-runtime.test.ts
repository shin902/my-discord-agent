import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

const { execute, refresh } = vi.hoisted(() => ({
  execute: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("../tools/agent-reach.js", () => ({
  agentReachTool: { execute },
}));
vi.mock("../proxy/reddit-cookie-refresh.js", () => ({
  refreshRedditCookies: refresh,
}));

import { createAgentReachRuntimeServer } from "./agent-reach-runtime.js";

const request = (
  port: number,
  options: { method: string; path: string; token?: string; body?: unknown },
): Promise<{ status: number; payload: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        method: options.method,
        path: options.path,
        headers: {
          ...(options.token
            ? { authorization: `Bearer ${options.token}` }
            : {}),
          ...(options.body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.end(JSON.stringify(options.body));
    else req.end();
  });

afterEach(() => {
  execute.mockReset();
  refresh.mockReset();
  delete process.env.AGENT_REACH_RUNTIME_TOKEN;
  delete process.env.AGENT_REACH_REFRESH_TOKEN;
});

describe("agent-reach Tool Runtime RPC", () => {
  it("認証済みの最小RPCだけを受け、resultにfilesystem pathを含めない", async () => {
    process.env.AGENT_REACH_RUNTIME_TOKEN = "runtime-token";
    execute.mockResolvedValue({
      content: [{ type: "text", text: "result" }],
      details: { service: "web" },
    });
    const server = createAgentReachRuntimeServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("not listening");
      const response = await request(address.port, {
        method: "POST",
        path: "/rpc",
        token: "runtime-token",
        body: { callId: "call-1", url: "https://example.com" },
      });
      expect(response.status).toBe(200);
      expect(response.payload).toEqual({
        result: {
          content: [{ type: "text", text: "result" }],
          details: { service: "web" },
        },
      });
      expect(execute).toHaveBeenCalledWith(
        expect.any(String),
        { url: "https://example.com" },
        expect.any(AbortSignal),
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("call revokeで実行中のagent-reachをabortする", async () => {
    process.env.AGENT_REACH_RUNTIME_TOKEN = "runtime-token";
    let aborted = false;
    execute.mockImplementation(
      async (_id: string, _args: unknown, signal: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        throw new Error("aborted");
      },
    );
    const server = createAgentReachRuntimeServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("not listening");
      const pending = request(address.port, {
        method: "POST",
        path: "/rpc",
        token: "runtime-token",
        body: { callId: "revoke-me", url: "https://example.com" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        (
          await request(address.port, {
            method: "DELETE",
            path: "/rpc/revoke-me",
            token: "runtime-token",
          })
        ).status,
      ).toBe(202);
      expect((await pending).status).toBe(502);
      expect(aborted).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refreshは別tokenのmaintenance endpointだけで実行する", async () => {
    process.env.AGENT_REACH_REFRESH_TOKEN = "refresh-token";
    const server = createAgentReachRuntimeServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("not listening");
      expect(
        (
          await request(address.port, {
            method: "POST",
            path: "/maintenance/reddit-cookie-refresh",
            token: "runtime-token",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await request(address.port, {
            method: "POST",
            path: "/maintenance/reddit-cookie-refresh",
            token: "refresh-token",
          })
        ).status,
      ).toBe(200);
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
