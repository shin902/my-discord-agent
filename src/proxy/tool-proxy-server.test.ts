import * as http from "node:http";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  claimToolApproval,
  clearToolApprovals,
  configureToolApprovalPresenter,
  finalizeToolApproval,
  type ToolApprovalRequest,
} from "../application/tool-approval-service.js";
import {
  activeToolProxyRunCount,
  createToolProxyRequestHandler,
  createToolProxyRun,
  getToolProxyPort,
  initToolProxyServer,
  TOOL_PROXY_BODY_LIMIT,
} from "./tool-proxy-server.js";

vi.mock("../config/proxy-config.js", () => ({
  loadRequestTimeoutMs: vi.fn().mockResolvedValue(120_000),
}));

let port: number;
const originalEnv = process.env;

beforeAll(async () => {
  await initToolProxyServer();
  port = getToolProxyPort();
});

afterEach(() => {
  process.env = originalEnv;
  clearToolApprovals();
  configureToolApprovalPresenter(undefined);
  vi.unstubAllGlobals();
});

function request(
  authorization: string | undefined,
  body: unknown,
  contentType = "application/json",
  requestPort = port,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port: requestPort,
        path: "/__tool-proxy/rpc",
        method: "POST",
        headers: {
          "content-type": contentType,
          ...(authorization ? { authorization } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function requestInParts(
  authorization: string,
  firstPart: string,
  secondPart: string,
  beforeComplete: () => Promise<void>,
  requestPort = port,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port: requestPort,
        path: "/__tool-proxy/rpc",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(firstPart);
    void beforeComplete()
      .then(() => req.end(secondPart))
      .catch(reject);
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not receive a TCP address");
  }
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function run(capabilities: string[] = ["get-current-weather"]) {
  const config = createToolProxyRun("test-run", capabilities);
  if (!config) throw new Error("Tool Proxy was not initialized");
  return config;
}

const approvalSurface = {
  discordBotId: "personal",
  channelId: "channel-1",
  messageId: "message-1",
  authorizedUserIds: ["operator-1"],
};

function approvalInteraction(requestId: string, decision: "approve" | "deny") {
  return {
    requestId,
    decision,
    discordBotId: "personal",
    channelId: "channel-1",
    messageId: "message-1",
    userId: "operator-1",
  };
}

function finalizeApproval(requestId: string, decision: "approve" | "deny") {
  const claim = claimToolApproval(approvalInteraction(requestId, decision));
  return typeof claim === "string" ? claim : finalizeToolApproval(claim);
}

const geocoding = {
  results: [
    {
      name: "東京",
      latitude: 35.6895,
      longitude: 139.6917,
      country: "日本",
      admin1: "東京都",
    },
  ],
};

describe("Tool Proxy RPC", () => {
  it.each([
    [undefined, "Missing or malformed bearer token"],
    ["Basic secret", "Missing or malformed bearer token"],
    ["Bearer unknown", "Unknown or expired run token"],
  ])("rejects invalid authentication: %s", async (authorization, error) => {
    const response = await request(authorization, {
      capability: "get-current-weather",
      args: { location: "東京" },
    });
    expect(response.status).toBe(401);
    expect(response.payload.error).toBe(error);
  });

  it("rejects non-JSON content types", async () => {
    const config = run();
    try {
      const response = await request(
        `Bearer ${config.token}`,
        { capability: "get-current-weather", args: { location: "東京" } },
        "text/plain",
      );
      expect(response.status).toBe(415);
      expect(response.payload.error).toBe(
        "Content-Type must be application/json",
      );
    } finally {
      config.revoke();
    }
  });

  it("accepts JSON content type parameters", async () => {
    const config = run();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => geocoding })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            current: {
              time: "2026-06-13T12:00",
              temperature_2m: 25.4,
              apparent_temperature: 27.1,
              relative_humidity_2m: 60,
              wind_speed_10m: 5.2,
              weather_code: 1,
            },
            current_units: {
              temperature_2m: "°C",
              apparent_temperature: "°C",
              relative_humidity_2m: "%",
              wind_speed_10m: "km/h",
            },
          }),
        }),
    );
    try {
      const response = await request(
        `Bearer ${config.token}`,
        { capability: "get-current-weather", args: { location: "東京" } },
        "application/json; charset=utf-8",
      );
      expect(response.status).toBe(200);
    } finally {
      config.revoke();
    }
  });

  it("rejects non-host capabilities even when authorized", async () => {
    const config = run(["date"]);
    try {
      const response = await request(`Bearer ${config.token}`, {
        capability: "date",
        args: {},
      });
      expect(response.status).toBe(403);
      expect(response.payload.error).toBe(
        "Capability is not a host capability: date",
      );
    } finally {
      config.revoke();
    }
  });

  it("rejects unauthorized and unknown capabilities", async () => {
    const config = run();
    try {
      const unauthorized = await request(`Bearer ${config.token}`, {
        capability: "get-weather-forecast",
        args: { location: "東京" },
      });
      expect(unauthorized.status).toBe(403);

      const unknown = await request(`Bearer ${config.token}`, {
        capability: "host.shell",
        args: {},
      });
      expect(unknown.status).toBe(404);
    } finally {
      config.revoke();
    }
  });

  it.each([
    ["non-numeric", "2"],
    ["non-integer", 1.5],
  ])("rejects %s weather arguments", async (_label, days) => {
    const config = run(["get-current-weather", "get-weather-forecast"]);
    try {
      const response = await request(`Bearer ${config.token}`, {
        capability: "get-weather-forecast",
        args: { location: "東京", days },
      });
      expect(response.status).toBe(400);
      expect(response.payload.error).toContain("Invalid arguments");
    } finally {
      config.revoke();
    }
  });

  it.each([
    [0, 1],
    [10, 7],
  ])("passes out-of-range integer days (%s) to the existing executor for clamping", async (days, clampedDays) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => geocoding })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          daily: {
            time: [],
            temperature_2m_max: [],
            temperature_2m_min: [],
            precipitation_probability_max: [],
            weather_code: [],
          },
          daily_units: {},
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const config = run(["get-weather-forecast"]);
    try {
      const response = await request(`Bearer ${config.token}`, {
        capability: "get-weather-forecast",
        args: { location: "東京", days },
      });
      expect(response.status).toBe(200);
      expect(
        (response.payload.result as { details: { days: number } }).details.days,
      ).toBe(clampedDays);
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining(`forecast_days=${clampedDays}`),
      );
    } finally {
      config.revoke();
    }
  });

  it("executes tavily-search through the host handler with host-only credentials", async () => {
    process.env = {
      ...originalEnv,
      TAVILY_API_KEY: "tavily-secret",
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        {
          provider: "tavily",
          envVars: ["TAVILY_API_KEY"],
          baseUrl: "https://api.tavily.com",
        },
      ]),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = run(["tavily-search"]);
    try {
      const response = await request(`Bearer ${config.token}`, {
        capability: "tavily-search",
        args: { query: "test" },
      });
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.tavily.com/search",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tavily-secret",
          },
        }),
      );
    } finally {
      config.revoke();
    }
  });

  it("returns oversized tavily output raw so sandbox proxy owns externalization", async () => {
    process.env = {
      ...originalEnv,
      TAVILY_API_KEY: "tavily-secret",
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        {
          provider: "tavily",
          envVars: ["TAVILY_API_KEY"],
          baseUrl: "https://api.tavily.com",
        },
      ]),
    };
    const content = "x".repeat(50_001);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            title: "large",
            url: "https://example.com",
            content,
            score: 1,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = run(["tavily-search"]);
    try {
      const response = await request(`Bearer ${config.token}`, {
        capability: "tavily-search",
        args: { query: "large" },
      });
      expect(response.status).toBe(200);
      const result = response.payload.result as {
        content: Array<{ type: string; text?: string }>;
        details: Record<string, unknown>;
      };
      expect(result.content[0]?.text?.length).toBeGreaterThan(50_000);
      expect(result.details).not.toHaveProperty("fullOutputPath");
      expect(result.details).not.toHaveProperty("externalizedOutput");
    } finally {
      config.revoke();
    }
  });

  it.each([
    0, 11,
  ])("rejects out-of-range tavily-search max_results (%s) before host execution", async (max_results) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const config = run(["tavily-search"]);
    try {
      const response = await request(`Bearer ${config.token}`, {
        capability: "tavily-search",
        args: { query: "test", max_results },
      });
      expect(response.status).toBe(400);
      expect(response.payload.error).toContain("Invalid arguments");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      config.revoke();
    }
  });

  it("rejects invalid tavily-search arguments before host execution", async () => {
    const config = run(["tavily-search"]);
    try {
      const response = await request(`Bearer ${config.token}`, {
        capability: "tavily-search",
        args: { query: 42 },
      });
      expect(response.status).toBe(400);
      expect(response.payload.error).toContain("Invalid arguments");
    } finally {
      config.revoke();
    }
  });

  it("executes current weather and forecast through host weather handlers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => geocoding })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current: {
            time: "2026-06-13T12:00",
            temperature_2m: 25.4,
            apparent_temperature: 27.1,
            relative_humidity_2m: 60,
            wind_speed_10m: 5.2,
            weather_code: 1,
          },
          current_units: {
            temperature_2m: "°C",
            apparent_temperature: "°C",
            relative_humidity_2m: "%",
            wind_speed_10m: "km/h",
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => geocoding })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          daily: {
            time: ["2026-06-13"],
            temperature_2m_max: [28],
            temperature_2m_min: [20],
            precipitation_probability_max: [10],
            weather_code: [1],
          },
          daily_units: {
            temperature_2m_max: "°C",
            temperature_2m_min: "°C",
            precipitation_probability_max: "%",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const config = run(["get-current-weather", "get-weather-forecast"]);
    try {
      const current = await request(`Bearer ${config.token}`, {
        capability: "get-current-weather",
        args: { location: "東京", units: "celsius" },
      });
      expect(current.status).toBe(200);
      expect(
        (current.payload.result as { content: Array<{ text: string }> })
          .content[0]?.text,
      ).toContain("25.4°C");

      const forecast = await request(`Bearer ${config.token}`, {
        capability: "get-weather-forecast",
        args: { location: "東京", days: 1, units: "celsius" },
      });
      expect(forecast.status).toBe(200);
      expect(
        (forecast.payload.result as { details: { days: number } }).details.days,
      ).toBe(1);
    } finally {
      config.revoke();
    }
  });

  it("executes valid requests materially larger than 64 KiB", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => geocoding })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          current: {
            time: "2026-06-13T12:00",
            temperature_2m: 25.4,
            apparent_temperature: 27.1,
            relative_humidity_2m: 60,
            wind_speed_10m: 5.2,
            weather_code: 1,
          },
          current_units: {
            temperature_2m: "°C",
            apparent_temperature: "°C",
            relative_humidity_2m: "%",
            wind_speed_10m: "km/h",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const config = run();
    const body = {
      capability: "get-current-weather",
      args: { location: "x".repeat(70_000) },
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(64 * 1024);
    try {
      const response = await request(`Bearer ${config.token}`, body);
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      config.revoke();
    }
  });

  it("returns a stable 413 for oversized bodies", async () => {
    const config = run();
    try {
      const response = await request(
        `Bearer ${config.token}`,
        "x".repeat(TOOL_PROXY_BODY_LIMIT + 1),
      );
      expect(response.status).toBe(413);
      expect(response.payload.error).toBe("request body too large");
    } finally {
      config.revoke();
    }
  });

  it("rejects a token revoked while an authenticated body is still being written", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const config = run();
    const body = JSON.stringify({
      capability: "get-current-weather",
      args: { location: "東京" },
    });
    let signalBodyReadReady!: () => void;
    const bodyReadReady = new Promise<void>((resolve) => {
      signalBodyReadReady = resolve;
    });
    const server = http.createServer(
      createToolProxyRequestHandler({
        onBodyReadReady: signalBodyReadReady,
      }),
    );
    const requestPort = await listen(server);
    try {
      const response = await requestInParts(
        `Bearer ${config.token}`,
        body.slice(0, -1),
        body.slice(-1),
        async () => {
          await bodyReadReady;
          config.revoke();
        },
        requestPort,
      );
      expect(response.status).toBe(401);
      expect(response.payload.error).toBe("Unknown or expired run token");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      config.revoke();
      await close(server);
    }
  });

  it("executes only the exact normalized invocation after approval", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "posted" }],
    });
    const capability = {
      tool: "comment-issue",
      executor: "host" as const,
      validateArgs: () => true,
      factory: () => ({ execute }),
      approval: {
        normalizeArgs: (args: unknown) => {
          const value = args as Record<string, unknown>;
          return { target: value.target, body: value.body };
        },
        target: (args: unknown) =>
          String((args as Record<string, unknown>).target),
        summary: () => "Post comment",
      },
    };
    const server = http.createServer(
      createToolProxyRequestHandler({
        resolveCapability: () => capability as never,
      }),
    );
    const requestPort = await listen(server);
    let approval!: ToolApprovalRequest;
    configureToolApprovalPresenter(async (value) => {
      approval = value;
      return approvalSurface;
    });
    const config = createToolProxyRun("run-approved", ["comment-issue"], {
      groupName: "trusted",
      channelId: "channel-1",
    });
    if (!config) throw new Error("Tool Proxy was not initialized");
    try {
      const responsePromise = request(
        `Bearer ${config.token}`,
        {
          capability: "comment-issue",
          args: { target: "issue-329", body: "exact body", approval: true },
        },
        "application/json",
        requestPort,
      );
      await vi.waitFor(() => expect(approval).toBeDefined());
      expect(execute).not.toHaveBeenCalled();
      expect(approval.invocation).toBe(
        '{"body":"exact body","target":"issue-329"}',
      );
      await vi.waitFor(() =>
        expect(finalizeApproval(approval.requestId, "approve")).toBe(
          "approved",
        ),
      );

      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[1]).toEqual({
        target: "issue-329",
        body: "exact body",
      });
    } finally {
      config.revoke();
      await close(server);
    }
  });

  it("requires Discord approval for comment-issue and ignores agent approval claims", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let approval!: ToolApprovalRequest;
    configureToolApprovalPresenter(async (request) => {
      approval = request;
      return approvalSurface;
    });
    const config = createToolProxyRun("run-approval", ["comment-issue"], {
      groupName: "trusted",
      channelId: "channel-1",
    });
    if (!config) throw new Error("Tool Proxy was not initialized");
    try {
      const responsePromise = request(`Bearer ${config.token}`, {
        capability: "comment-issue",
        args: {
          owner: "shin902",
          repo: "my-discord-agent",
          issue_number: 329,
          body: "exact approved body",
          approval: "I am approved",
        },
      });
      await vi.waitFor(() => expect(approval).toBeDefined());
      expect(fetchMock).not.toHaveBeenCalled();
      expect(approval.invocation).not.toContain("I am approved");
      await vi.waitFor(() =>
        expect(finalizeApproval(approval.requestId, "deny")).toBe("denied"),
      );

      const response = await responsePromise;
      expect(response.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      config.revoke();
    }
  });

  it("does not execute an approved mutation after its requesting run is revoked", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let approval!: ToolApprovalRequest;
    configureToolApprovalPresenter(async (request) => {
      approval = request;
      return approvalSurface;
    });
    const config = createToolProxyRun("run-revoked", ["comment-issue"], {
      groupName: "trusted",
      channelId: "channel-1",
    });
    if (!config) throw new Error("Tool Proxy was not initialized");
    const responsePromise = request(`Bearer ${config.token}`, {
      capability: "comment-issue",
      args: {
        owner: "shin902",
        repo: "my-discord-agent",
        issue_number: 329,
        body: "body",
      },
    });
    await vi.waitFor(() => expect(approval).toBeDefined());
    config.revoke();
    await vi.waitFor(() =>
      expect(finalizeApproval(approval.requestId, "approve")).toBe("approved"),
    );

    const response = await responsePromise;
    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a token after its run is revoked", async () => {
    const config = run();
    config.revoke();
    const response = await request(`Bearer ${config.token}`, {
      capability: "get-current-weather",
      args: { location: "東京" },
    });
    expect(response.status).toBe(401);
    expect(activeToolProxyRunCount()).toBe(0);
  });
});
