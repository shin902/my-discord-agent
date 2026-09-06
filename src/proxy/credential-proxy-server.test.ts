import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";

const makeReq = (
  url: string,
  headers: Record<string, string> = {},
  method = "POST",
  body?: string,
) =>
  ({
    url,
    headers,
    method,
    ...(body !== undefined ? { body } : {}),
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
    const handler = createRequestHandler(CREDS, 30000);
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
    const handler = createRequestHandler(badCreds, 30000);
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
    const handler = createRequestHandler(CREDS, 30000);
    handler(
      makeReq("/openai/chat/completions?stream=true"),
      makeRes() as unknown as ServerResponse,
    );
    const opts = requestMock.mock.calls[0][0];
    expect(opts.path).toBe("/v1/chat/completions?stream=true");
  });

  it.each([
    "/openai/../admin",
    "/openai/%2e%2e/admin",
    "/openai/..%2fadmin",
    "/openai/%2e%2e%5cadmin",
    "/openai/%252e%252e%252fadmin",
    "/openai/%25%32%65%25%32%65%25%32%66admin",
  ])("path traversal を upstream へ転送しない (%s)", async (path) => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS, 30000);
    const res = makeRes();

    handler(makeReq(path), res as unknown as ServerResponse);

    expect(res.writeHead).toHaveBeenCalledWith(400);
    expect(res.end).toHaveBeenCalledWith("Invalid request path");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("深くネストした harmless な percent encoding は bounded decode 後に拒否する", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS, 30000);
    const res = makeRes();
    const nestedEncoding = (terminal: string) =>
      `%${"25".repeat(9)}${terminal}`;
    const path = `/openai/${nestedEncoding("61")}`;

    handler(makeReq(path), res as unknown as ServerResponse);

    expect(res.writeHead).toHaveBeenCalledWith(400);
    expect(res.end).toHaveBeenCalledWith("Invalid request path");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("通常のドットを含む path はそのまま転送する", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS, 30000);

    handler(
      makeReq("/openai/files/archive..json"),
      makeRes() as unknown as ServerResponse,
    );

    const opts = requestMock.mock.calls[0][0];
    expect(opts.path).toBe("/v1/files/archive..json");
  });

  it("host ヘッダは upstream に転送しない", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS, 30000);
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
    const handler = createRequestHandler(CREDS, 30000);
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
    const handler = createRequestHandler(CREDS, 30000);
    const res = makeRes();
    handler(makeReq("/openai/v1"), res as unknown as ServerResponse);

    const errorCb = upstreamOnMock.mock.calls.find(([e]) => e === "error")?.[1];
    expect(errorCb).toBeDefined();
    errorCb(new Error("connection refused"));
    expect(res.writeHead).toHaveBeenCalledWith(502);
    expect(res.end).toHaveBeenCalledWith("Bad Gateway");
  });

  it("opts.timeout が createRequestHandler に渡した値で設定される", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS, 5000);
    handler(makeReq("/openai/v1"), makeRes() as unknown as ServerResponse);
    const opts = requestMock.mock.calls[0][0];
    expect(opts.timeout).toBe(5000);
  });
});

describe("createRequestHandler: タイムアウト", () => {
  let requestMock: ReturnType<typeof vi.fn>;
  let upstreamOnMock: ReturnType<typeof vi.fn>;
  let upstreamDestroyMock: ReturnType<typeof vi.fn>;

  const CREDS: CredentialEntry[] = [
    {
      provider: "openai",
      envVars: ["OPENAI_API_KEY"],
      baseUrl: "http://fake-openai.test/v1",
    },
  ];

  beforeEach(() => {
    vi.resetModules();
    upstreamDestroyMock = vi.fn();
    upstreamOnMock = vi.fn().mockReturnThis();
    requestMock = vi.fn(() => ({
      on: upstreamOnMock,
      destroy: upstreamDestroyMock,
    }));
    vi.doMock("node:http", () => ({ request: requestMock }));
    vi.doMock("node:https", () => ({ request: vi.fn() }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("timeout イベントで destroy を呼ぶ", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS, 5000);
    handler(makeReq("/openai/v1"), makeRes() as unknown as ServerResponse);

    const timeoutCb = upstreamOnMock.mock.calls.find(
      ([e]) => e === "timeout",
    )?.[1];
    expect(timeoutCb).toBeDefined();
    timeoutCb();
    expect(upstreamDestroyMock).toHaveBeenCalled();
  });

  it("timeout 後の error イベントで 504 Gateway Timeout を返す", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS, 5000);
    const res = makeRes();
    handler(makeReq("/openai/v1"), res as unknown as ServerResponse);

    const timeoutCb = upstreamOnMock.mock.calls.find(
      ([e]) => e === "timeout",
    )?.[1];
    timeoutCb();

    // destroy に渡された UpstreamTimeoutError インスタンスをそのまま error ハンドラへ流す
    const destroyArg = upstreamDestroyMock.mock.calls[0]?.[0];
    const errorCb = upstreamOnMock.mock.calls.find(([e]) => e === "error")?.[1];
    errorCb(destroyArg);

    expect(res.writeHead).toHaveBeenCalledWith(504);
    expect(res.end).toHaveBeenCalledWith("Gateway Timeout");
  });

  it("ヘッダ送信済みの場合は res.destroy() でソケットを切断する", async () => {
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS, 5000);
    const res = makeRes();
    const resDestroyMock = vi.fn();
    (res as unknown as Record<string, unknown>).headersSent = true;
    (res as unknown as Record<string, unknown>).destroy = resDestroyMock;
    handler(makeReq("/openai/v1"), res as unknown as ServerResponse);

    const timeoutCb = upstreamOnMock.mock.calls.find(
      ([e]) => e === "timeout",
    )?.[1];
    timeoutCb();

    const errorCb = upstreamOnMock.mock.calls.find(([e]) => e === "error")?.[1];
    const err = new Error("upstream timeout for openai");
    errorCb(err);

    expect(res.writeHead).not.toHaveBeenCalledWith(504);
    expect(resDestroyMock).toHaveBeenCalledWith(err);
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
    },
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
    const handler = createRequestHandler(GRAPH_CREDS, 30000);
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
    const handler = createRequestHandler(GRAPH_CREDS, 30000);
    const req = makeReq("/graph/me/messages");
    const res = makeRes();
    handler(req, res as unknown as ServerResponse);
    await new Promise((r) => setTimeout(r, 0));
    expect(res.writeHead).toHaveBeenCalledWith(502);
    expect(res.end).toHaveBeenCalledWith("Graph token acquisition failed");
  });

  it("upstreamRes の end イベントで handleRequest の Promise が解決され writeHead と pipe が呼ばれる", async () => {
    vi.doMock("./graph-auth.js", () => ({
      initGraphAuth: vi.fn(),
      getGraphAccessToken: vi.fn().mockResolvedValue("msal-access-token"),
    }));

    let capturedResponseCb: ((upstreamRes: unknown) => void) | undefined;
    requestMock.mockImplementation(
      (_opts: unknown, cb: (r: unknown) => void) => {
        capturedResponseCb = cb;
        return { on: vi.fn(), pipe: vi.fn() };
      },
    );

    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(GRAPH_CREDS, 30000);
    const req = makeReq("/graph/me/messages");
    const res = makeRes();

    handler(req, res as unknown as ServerResponse);

    // getGraphAccessToken の非同期解決を待つ
    await new Promise((r) => setTimeout(r, 0));
    expect(capturedResponseCb).toBeDefined();

    // upstreamRes のシミュレート（EventEmitter の簡易実装）
    const listeners: Record<string, Array<() => void>> = {};
    const fakeUpstreamRes = {
      pipe: vi.fn(),
      statusCode: 200,
      headers: { "content-type": "application/json" },
      on: (event: string, cb: () => void) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(cb);
      },
      emit: (event: string) => {
        listeners[event]?.forEach((cb) => {
          cb();
        });
      },
    };

    capturedResponseCb?.(fakeUpstreamRes);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "content-type": "application/json",
    });
    expect(fakeUpstreamRes.pipe).toHaveBeenCalledWith(res);

    // end を発火 → handleRequest の Promise が解決される（タイムアウトせず完了する）
    fakeUpstreamRes.emit("end");
    await new Promise((r) => setTimeout(r, 0));
    // 500 Internal Server Error が返っていなければ Promise は正常解決
    expect(res.writeHead).not.toHaveBeenCalledWith(500);
  });
});

describe("createRequestHandler: Google OAuth プロバイダー", () => {
  let requestMock: ReturnType<typeof vi.fn>;

  const GOOGLE_CREDS: CredentialEntry[] = [
    {
      provider: "google-calendar",
      baseUrl: "http://fake-google.test/calendar/v3",
      google: {
        clientId: "test-client-id",
        clientSecretEnvVar: "GOOGLE_CALENDAR_CLIENT_SECRET",
        scopes: ["https://www.googleapis.com/auth/calendar"],
      },
    },
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

  it("google プロバイダーは getGoogleAccessToken(provider) のトークンを Bearer で注入する", async () => {
    const getGoogleAccessToken = vi
      .fn()
      .mockResolvedValue("google-access-token");
    vi.doMock("./google-auth.js", () => ({
      initGoogleAuth: vi.fn(),
      getGoogleAccessToken,
    }));
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(GOOGLE_CREDS, 30000);
    const req = makeReq("/google-calendar/calendars/primary/events");
    const res = makeRes();
    handler(req, res as unknown as ServerResponse);
    await new Promise((r) => setTimeout(r, 0));
    expect(getGoogleAccessToken).toHaveBeenCalledWith("google-calendar");
    const opts = requestMock.mock.calls[0]?.[0];
    expect(opts?.headers.authorization).toBe("Bearer google-access-token");
  });

  it("getGoogleAccessToken() が失敗したとき 502 を返す", async () => {
    vi.doMock("./google-auth.js", () => ({
      initGoogleAuth: vi.fn(),
      getGoogleAccessToken: vi.fn().mockRejectedValue(new Error("auth failed")),
      GoogleAuthRequiredError: class GoogleAuthRequiredError extends Error {},
    }));
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(GOOGLE_CREDS, 30000);
    const req = makeReq("/google-calendar/calendars/primary/events");
    const res = makeRes();
    handler(req, res as unknown as ServerResponse);
    await new Promise((r) => setTimeout(r, 0));
    expect(res.writeHead).toHaveBeenCalledWith(502);
    expect(res.end).toHaveBeenCalledWith("Google token acquisition failed");
  });
});

describe("createRequestHandler: Authorization ヘッダ", () => {
  const originalEnv = process.env;
  let requestMock: ReturnType<typeof vi.fn>;
  let httpsRequestMock: ReturnType<typeof vi.fn>;

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
    httpsRequestMock = vi.fn(() => ({ on: vi.fn() }));
    vi.doMock("node:http", () => ({ request: requestMock }));
    vi.doMock("node:https", () => ({ request: httpsRequestMock }));
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
    const handler = createRequestHandler(CREDS, 30000);
    handler(
      makeReq("/openai/chat/completions", { authorization: "Bearer fake" }),
      makeRes() as unknown as ServerResponse,
    );
    const opts = requestMock.mock.calls[0][0];
    expect(opts.headers.authorization).toBe("Bearer sk-test-key");
  });

  it("auth.type=query-token はトークンを query parameter に注入する", async () => {
    process.env.QUERY_API_TOKEN = "query-test-token";
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(
      [
        {
          provider: "query-api",
          envVars: ["QUERY_API_TOKEN"],
          auth: { type: "query-token" },
          baseUrl: "https://api.example.com",
        },
      ],
      30000,
    );
    handler(
      makeReq("/query-api/content?timeout=30000", {
        authorization: "Bearer fake",
      }),
      makeRes() as unknown as ServerResponse,
    );
    const opts = httpsRequestMock.mock.calls[0][0];
    expect(opts.path).toBe("/content?timeout=30000&token=query-test-token");
    expect(opts.headers.authorization).toBeUndefined();
  });

  it("auth.queryParam で query parameter 名を変更できる", async () => {
    process.env.TEST_API_KEY = "query-test-key";
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(
      [
        {
          provider: "query-api",
          envVars: ["TEST_API_KEY"],
          auth: { type: "query-token", queryParam: "api_key" },
          baseUrl: "https://api.example.com/v1?existing=true",
        },
      ],
      30000,
    );
    handler(
      makeReq("/query-api/content"),
      makeRes() as unknown as ServerResponse,
    );
    const opts = httpsRequestMock.mock.calls[0][0];
    expect(opts.path).toBe("/v1/content?existing=true&api_key=query-test-key");
  });

  it("auth.type=basic はユーザー名とトークンを Base64 エンコードした Basic 認証を注入する", async () => {
    process.env.BASIC_API_TOKEN = "basic-test-token";
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(
      [
        {
          provider: "basic-api",
          envVars: ["BASIC_API_TOKEN"],
          auth: { type: "basic", username: "api-user" },
          baseUrl: "https://api.example.com",
        },
      ],
      30000,
    );
    handler(
      makeReq("/basic-api/resource", {
        authorization: "Bearer fake",
      }),
      makeRes() as unknown as ServerResponse,
    );
    const opts = httpsRequestMock.mock.calls[0][0];
    const expectedCredential = Buffer.from(
      "api-user:basic-test-token",
    ).toString("base64");
    expect(opts.headers.authorization).toBe(`Basic ${expectedCredential}`);
  });

  it("auth.type=basic で username を省略した場合は x-access-token を既定値に使う", async () => {
    process.env.BASIC_API_TOKEN = "basic-test-token";
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(
      [
        {
          provider: "basic-api",
          envVars: ["BASIC_API_TOKEN"],
          auth: { type: "basic" },
          baseUrl: "https://api.example.com",
        },
      ],
      30000,
    );
    handler(
      makeReq("/basic-api/resource"),
      makeRes() as unknown as ServerResponse,
    );
    const opts = httpsRequestMock.mock.calls[0][0];
    const expectedCredential = Buffer.from(
      "x-access-token:basic-test-token",
    ).toString("base64");
    expect(opts.headers.authorization).toBe(`Basic ${expectedCredential}`);
  });

  it("envVars が全て未設定の場合は Authorization ヘッダを削除する", async () => {
    delete process.env.OPENAI_API_KEY;
    const { createRequestHandler } = await import(
      "./credential-proxy-server.js"
    );
    const handler = createRequestHandler(CREDS, 30000);
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
    const handler = createRequestHandler(CREDS, 30000);
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

describe("internal agent route: scoped authorization", () => {
  let serverRequestHandler:
    | ((req: IncomingMessage, res: ServerResponse) => void)
    | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("node:http", () => ({
      createServer: vi.fn((handler) => {
        serverRequestHandler = handler;
        return {
          on: vi.fn(),
          listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
          address: vi.fn(() => ({ port: 12345 })),
        };
      }),
      request: vi.fn(),
    }));
    vi.doMock("node:https", () => ({ request: vi.fn() }));
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock("../config/proxy-config.js", () => ({
      loadRequestTimeoutMs: vi.fn().mockResolvedValue(120_000),
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  async function setup() {
    const proxy = await import("./credential-proxy-server.js");
    await proxy.initCredentialProxyServer();
    return proxy;
  }

  it("valid tokenはscopeとheld providerをhandlerへ渡す", async () => {
    const proxy = await setup();
    const handler = vi.fn().mockResolvedValue(undefined);
    proxy.registerInternalRequestHandler(handler);
    const destination = { botId: "secondary", channelId: "channel-1" };
    const config = proxy.createInternalRequestConfig(
      "main",
      "openai",
      destination,
    );
    expect(config).toMatchObject({ port: 12345, token: expect.any(String) });

    serverRequestHandler?.(
      makeReq(
        "/__agent/bot",
        { "x-agent-internal-token": config?.token ?? "" },
        "POST",
        JSON.stringify({
          trustedDiscordDestination: {
            botId: "forged",
            channelId: "forged",
          },
        }),
      ),
      makeRes() as unknown as ServerResponse,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handler).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "main",
      "openai",
      {
        botId: "secondary",
        channelId: "channel-1",
      },
    );

    // Neither the request body nor the original object can override token-bound context.
    destination.botId = "forged";
    destination.channelId = "forged";
    expect(handler).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      "main",
      "openai",
      {
        botId: "secondary",
        channelId: "channel-1",
      },
    );

    config?.revoke();
    const revokedResponse = makeRes();
    serverRequestHandler?.(
      makeReq("/__agent/bot", {
        "x-agent-internal-token": config?.token ?? "",
      }),
      revokedResponse as unknown as ServerResponse,
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(revokedResponse.writeHead).toHaveBeenCalledWith(404);
    expect(revokedResponse.end).toHaveBeenCalledWith("Not Found");
  });

  it("run中は15分を超えてもtokenが有効で、revoke後は無効になる", async () => {
    vi.useFakeTimers();
    const proxy = await setup();
    const handler = vi.fn().mockResolvedValue(undefined);
    proxy.registerInternalRequestHandler(handler);
    const config = proxy.createInternalRequestConfig("main");
    expect(config).toBeDefined();

    serverRequestHandler?.(
      makeReq("/__agent/bot", {
        "x-agent-internal-token": config?.token ?? "",
      }),
      makeRes() as unknown as ServerResponse,
    );
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(handler).toHaveBeenCalledOnce();

    config?.revoke();
    config?.revoke();
    const revokedResponse = makeRes();
    serverRequestHandler?.(
      makeReq("/__agent/bot", {
        "x-agent-internal-token": config?.token ?? "",
      }),
      revokedResponse as unknown as ServerResponse,
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(revokedResponse.writeHead).toHaveBeenCalledWith(404);
  });

  it.each([
    "",
    "invalid-token",
  ])("missing/invalid tokenは内部routeを拒否する (%s)", async (token) => {
    const proxy = await setup();
    const handler = vi.fn().mockResolvedValue(undefined);
    proxy.registerInternalRequestHandler(handler);
    const res = makeRes();

    serverRequestHandler?.(
      makeReq("/__agent/bot", token ? { "x-agent-internal-token": token } : {}),
      res as unknown as ServerResponse,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(404);
    expect(res.end).toHaveBeenCalledWith("Not Found");
  });
});

describe("initCredentialProxyServer: Google Auth 初期化", () => {
  const originalEnv = process.env;
  const GOOGLE_CREDS: CredentialEntry[] = [
    {
      provider: "google-calendar",
      baseUrl: "https://www.googleapis.com/calendar/v3",
      google: {
        clientId: "test-client-id",
        clientSecretEnvVar: "GOOGLE_CALENDAR_CLIENT_SECRET",
        scopes: ["https://www.googleapis.com/auth/calendar"],
      },
    },
  ];

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.doMock("node:http", () => ({
      createServer: vi.fn(() => ({
        on: vi.fn(),
        listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
        address: vi.fn(() => ({ port: 12345 })),
      })),
      request: vi.fn(),
    }));
    vi.doMock("node:https", () => ({ request: vi.fn() }));
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue(GOOGLE_CREDS),
    }));
    vi.doMock("../config/proxy-config.js", () => ({
      loadRequestTimeoutMs: vi.fn().mockResolvedValue(120_000),
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it("clientSecretEnvVar が未設定のとき Google Auth をスキップして警告する", async () => {
    delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const initGoogleAuth = vi.fn();
    vi.doMock("./google-auth.js", () => ({
      initGoogleAuth,
      getGoogleAccessToken: vi.fn(),
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { initCredentialProxyServer } = await import(
      "./credential-proxy-server.js"
    );
    await initCredentialProxyServer();

    expect(initGoogleAuth).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("GOOGLE_CALENDAR_CLIENT_SECRET"),
    );
    warnSpy.mockRestore();
  });

  it("clientSecretEnvVar が設定済みのとき initGoogleAuth を呼ぶ", async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
    const initGoogleAuth = vi.fn();
    vi.doMock("./google-auth.js", () => ({
      initGoogleAuth,
      getGoogleAccessToken: vi.fn(),
    }));

    const { initCredentialProxyServer } = await import(
      "./credential-proxy-server.js"
    );
    await initCredentialProxyServer();

    expect(initGoogleAuth).toHaveBeenCalledWith(
      "google-calendar",
      GOOGLE_CREDS[0]?.google,
      "test-secret",
    );
  });

  it("起動時に getGoogleAccessToken を呼んでデバイスコードフローを済ませておく", async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
    const getGoogleAccessToken = vi.fn().mockResolvedValue("token");
    vi.doMock("./google-auth.js", () => ({
      initGoogleAuth: vi.fn(),
      getGoogleAccessToken,
    }));

    const { initCredentialProxyServer } = await import(
      "./credential-proxy-server.js"
    );
    await initCredentialProxyServer();

    expect(getGoogleAccessToken).toHaveBeenCalledWith("google-calendar");
  });

  it("getGoogleAccessToken が失敗してもサーバー起動は継続する", async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
    const getGoogleAccessToken = vi
      .fn()
      .mockRejectedValue(new Error("device flow timeout"));
    vi.doMock("./google-auth.js", () => ({
      initGoogleAuth: vi.fn(),
      getGoogleAccessToken,
      GoogleAuthRequiredError: class GoogleAuthRequiredError extends Error {},
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { initCredentialProxyServer } = await import(
      "./credential-proxy-server.js"
    );
    const port = await initCredentialProxyServer();

    expect(port).toBe(12345);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("device flow timeout"),
    );
    errorSpy.mockRestore();
  });
});
