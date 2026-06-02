import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";

const makeReq = (
  url: string,
  headers: Record<string, string> = {},
  method = "POST",
) =>
  ({
    url,
    headers,
    method,
    pipe: vi.fn(),
  }) as unknown as IncomingMessage;

const makeRes = () =>
  ({
    writeHead: vi.fn(),
    end: vi.fn(),
    headersSent: false,
  }) as unknown as ServerResponse & {
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };

describe("getProxyPort: 初期化前の例外", () => {
  it("初期化前に呼ぶと例外を投げる", async () => {
    vi.resetModules();
    const { getProxyPort } = await import("./credential-proxy-server.js");
    expect(() => getProxyPort()).toThrow(
      "credential proxy server は未初期化です",
    );
  });
});

describe("createRequestHandler: エラーレスポンス", () => {
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    requestMock = vi.fn(() => ({ on: vi.fn() }));
    vi.doMock("node:http", () => ({ request: requestMock }));
    vi.doMock("node:https", () => ({ request: vi.fn() }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  const CREDS: CredentialEntry[] = [
    {
      provider: "openai",
      envVars: ["OPENAI_API_KEY"],
      baseUrl: "http://fake-openai.test/v1",
    },
  ];

  it("未知のプロバイダは 404 を返す", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS);
    const req = makeReq("/unknown/endpoint");
    const res = makeRes();
    handler(req, res as unknown as ServerResponse);
    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining("unknown"));
  });

  it("baseUrl に未解決のプレースホルダがある場合は 502 を返す", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const badCreds: CredentialEntry[] = [
      {
        provider: "bad",
        baseUrl: "http://fake.test/{UNSET_VAR_XYZ}/v1" as unknown as string,
      } as CredentialEntry,
    ];
    const handler = createRequestHandler(badCreds);
    const req = makeReq("/bad/completions");
    const res = makeRes();
    handler(req, res as unknown as ServerResponse);
    expect(res.writeHead).toHaveBeenCalledWith(502);
    expect(res.end).toHaveBeenCalledWith(expect.stringContaining("bad"));
  });
});

describe("createRequestHandler: upstream リクエスト転送", () => {
  let requestMock: ReturnType<typeof vi.fn>;
  let upstreamOnMock: ReturnType<typeof vi.fn>;

  const CREDS: CredentialEntry[] = [
    {
      provider: "openai",
      envVars: ["OPENAI_API_KEY"],
      baseUrl: "http://fake-openai.test/v1",
    },
  ];

  beforeEach(() => {
    vi.resetModules();
    upstreamOnMock = vi.fn().mockReturnThis();
    requestMock = vi.fn(() => ({ on: upstreamOnMock }));
    vi.doMock("node:http", () => ({ request: requestMock }));
    vi.doMock("node:https", () => ({ request: vi.fn() }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("path と query が正しく転送される", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS);
    handler(
      makeReq("/openai/chat/completions?stream=true"),
      makeRes() as unknown as ServerResponse,
    );
    const opts = requestMock.mock.calls[0][0];
    expect(opts.path).toBe("/v1/chat/completions?stream=true");
  });

  it("host ヘッダは upstream に転送しない", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS);
    handler(
      makeReq("/openai/v1", {
        host: "example.com",
        "content-type": "application/json",
      }),
      makeRes() as unknown as ServerResponse,
    );
    const opts = requestMock.mock.calls[0][0];
    expect(opts.headers.host).toBeUndefined();
    expect(opts.headers["content-type"]).toBe("application/json");
  });

  it("HTTP メソッドが保持される", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS);
    handler(
      makeReq("/openai/v1", {}, "GET"),
      makeRes() as unknown as ServerResponse,
    );
    const opts = requestMock.mock.calls[0][0];
    expect(opts.method).toBe("GET");
  });

  it("upstream error のとき 502 Bad Gateway を返す", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS);
    const res = makeRes();
    handler(makeReq("/openai/v1"), res as unknown as ServerResponse);

    const errorCb = upstreamOnMock.mock.calls.find(([e]) => e === "error")?.[1];
    expect(errorCb).toBeDefined();
    errorCb(new Error("connection refused"));
    expect(res.writeHead).toHaveBeenCalledWith(502);
    expect(res.end).toHaveBeenCalledWith("Bad Gateway");
  });
});

describe("createRequestHandler: MSAL プロバイダー", () => {
  let requestMock: ReturnType<typeof vi.fn>;

  const GRAPH_CREDS: CredentialEntry[] = [
    {
      provider: "graph",
      baseUrl: "http://fake-graph.test/v1.0",
      msal: {
        tenantId: "consumers",
        clientId: "test-client-id",
        scopes: ["https://graph.microsoft.com/Mail.Read"],
      },
    } as unknown as CredentialEntry,
  ];

  beforeEach(() => {
    vi.resetModules();
    requestMock = vi.fn(() => ({ on: vi.fn(), pipe: vi.fn() }));
    vi.doMock("node:http", () => ({
      request: requestMock,
      createServer: vi.fn(),
    }));
    vi.doMock("node:https", () => ({ request: requestMock }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("msal プロバイダーは getGraphAccessToken(provider) のトークンを Bearer で注入する", async () => {
    const getGraphAccessToken = vi.fn().mockResolvedValue("msal-access-token");
    vi.doMock("./graph-auth.js", () => ({
      initGraphAuth: vi.fn(),
      getGraphAccessToken,
    }));
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(GRAPH_CREDS);
    const req = makeReq("/graph/me/messages");
    const res = makeRes();
    handler(req, res as unknown as ServerResponse);
    // 非同期でトークン取得するため、次の microtask まで待つ
    await new Promise((r) => setTimeout(r, 0));
    expect(getGraphAccessToken).toHaveBeenCalledWith("graph");
    const opts = requestMock.mock.calls[0]?.[0];
    expect(opts?.headers.authorization).toBe("Bearer msal-access-token");
  });

  it("getGraphAccessToken() が失敗したとき 502 を返す", async () => {
    vi.doMock("./graph-auth.js", () => ({
      initGraphAuth: vi.fn(),
      getGraphAccessToken: vi.fn().mockRejectedValue(new Error("auth failed")),
    }));
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(GRAPH_CREDS);
    const req = makeReq("/graph/me/messages");
    const res = makeRes();
    handler(req, res as unknown as ServerResponse);
    await new Promise((r) => setTimeout(r, 0));
    expect(res.writeHead).toHaveBeenCalledWith(502);
    expect(res.end).toHaveBeenCalledWith("Graph token acquisition failed");
  });
});

describe("createRequestHandler: Authorization ヘッダ", () => {
  const originalEnv = process.env;
  let requestMock: ReturnType<typeof vi.fn>;

  const CREDS: CredentialEntry[] = [
    {
      provider: "openai",
      envVars: ["OPENAI_API_KEY"],
      baseUrl: "http://fake-openai.test/v1",
    },
    { provider: "local-llm", baseUrl: "http://localhost:8080/v1" },
  ];

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    requestMock = vi.fn(() => ({ on: vi.fn() }));
    vi.doMock("node:http", () => ({ request: requestMock }));
    vi.doMock("node:https", () => ({ request: vi.fn() }));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it("envVars に設定済みの環境変数があれば Bearer トークンを注入する", async () => {
    process.env.OPENAI_API_KEY = "sk-test-key";
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS);
    handler(
      makeReq("/openai/chat/completions", { authorization: "Bearer fake" }),
      makeRes() as unknown as ServerResponse,
    );
    const opts = requestMock.mock.calls[0][0];
    expect(opts.headers.authorization).toBe("Bearer sk-test-key");
  });

  it("envVars が全て未設定の場合は Authorization ヘッダを削除する", async () => {
    delete process.env.OPENAI_API_KEY;
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS);
    handler(
      makeReq("/openai/chat/completions", { authorization: "Bearer fake" }),
      makeRes() as unknown as ServerResponse,
    );
    const opts = requestMock.mock.calls[0][0];
    expect(opts.headers.authorization).toBeUndefined();
  });

  it("envVars がないプロバイダは Authorization ヘッダをそのまま通す", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS);
    handler(
      makeReq("/local-llm/completions", {
        authorization: "Bearer pass-through",
      }),
      makeRes() as unknown as ServerResponse,
    );
    const opts = requestMock.mock.calls[0][0];
    expect(opts.headers.authorization).toBe("Bearer pass-through");
  });
});
