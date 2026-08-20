import { IncomingMessage, ServerResponse, ClientRequest } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";
import {
  createRequestHandler,
  initCredentialProxyServer,
  type CredentialProxyDependencies,
  type ProxyRequestCallback,
  type ProxyRequestFunction,
  type ProxyRequestOptions,
  type ProxyCreateServer,
} from "./credential-proxy-server.js";

type RequestOptions = ProxyRequestOptions;
type RequestCallback = ProxyRequestCallback;
type RequestSpy = ReturnType<typeof vi.fn<ProxyRequestFunction>>;

class FakeRequest extends IncomingMessage {
  constructor(url: string, headers: Record<string, string>, method: string) {
    super(new Socket());
    this.url = url;
    this.headers = headers;
    this.method = method;
  }
}

class FakeUpstream extends ClientRequest {
  readonly destroySpy = vi.fn((error?: Error) => {
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit("error", error));
    return this;
  });

  constructor() {
    super({ method: "POST", host: "localhost", port: 1 });
    this.on("error", () => undefined);
    this.destroy = this.destroySpy;
  }
}

function makeReq(
  url: string,
  headers: Record<string, string> = {},
  method = "POST",
): IncomingMessage {
  return new FakeRequest(url, headers, method);
}

function makeRes(): ServerResponse {
  const response = new ServerResponse(new FakeRequest("/", {}, "GET"));
  vi.spyOn(response, "writeHead").mockImplementation(() => response);
  vi.spyOn(response, "end").mockImplementation(() => response);
  vi.spyOn(response, "destroy").mockImplementation(() => response);
  Object.defineProperty(response, "headersSent", {
    value: false,
    configurable: true,
  });
  return response;
}

function makeDependencies(
  request: CredentialProxyDependencies["request"],
  overrides: Partial<CredentialProxyDependencies> = {},
): CredentialProxyDependencies {
  const noop = vi.fn().mockResolvedValue(undefined);
  return {
    request,
    httpsRequest: request,
    createServer: vi.fn(),
    loadCredentialProxy: vi.fn().mockResolvedValue([]),
    loadRequestTimeoutMs: vi.fn().mockResolvedValue(30_000),
    initGraphAuth: noop,
    getGraphAccessToken: vi.fn().mockResolvedValue("graph-token"),
    initGoogleAuth: noop,
    getGoogleAccessToken: vi.fn().mockResolvedValue("google-token"),
    getRedditCookieHeader: vi.fn().mockResolvedValue("session=abc"),
    ...overrides,
  };
}

const OPENAI: CredentialEntry[] = [
  {
    provider: "openai",
    envVars: ["OPENAI_API_KEY"],
    baseUrl: "http://fake-openai.test/v1",
  },
];

function requestHarness() {
  const upstream = new FakeUpstream();
  const request = vi.fn<ProxyRequestFunction>();
  request.mockImplementation((_options, callback) => {
    if (callback) upstream.once("response", callback);
    return upstream;
  });
  return { upstream, request, dependencies: makeDependencies(request) };
}

function requestOptions(request: RequestSpy): RequestOptions {
  const options = request.mock.calls[0]?.[0];
  if (!options) throw new Error("request options were not provided");
  return options;
}

function requestCallback(request: RequestSpy): NonNullable<RequestCallback> {
  const callback = request.mock.calls[0]?.[1];
  if (!callback) throw new Error("request callback was not provided");
  return callback;
}

describe("credential proxy request handler", () => {
  it("rejects unknown and unresolved providers", () => {
    const { request, dependencies } = requestHarness();
    const handler = createRequestHandler(OPENAI, 30_000, dependencies);
    const unknown = makeRes();
    handler(makeReq("/unknown/endpoint"), unknown);
    expect(unknown.writeHead).toHaveBeenCalledWith(404);
    expect(unknown.end).toHaveBeenCalledWith("Unknown provider: unknown");

    const unresolved: CredentialEntry[] = [
      { provider: "bad", baseUrl: "http://fake.test/{UNSET_VAR_XYZ}/v1" },
    ];
    const bad = makeRes();
    createRequestHandler(
      unresolved,
      30_000,
      dependencies,
    )(makeReq("/bad/completions"), bad);
    expect(bad.writeHead).toHaveBeenCalledWith(502);
    expect(request).not.toHaveBeenCalled();
  });

  it("forwards URL, method, timeout, and non-host headers", () => {
    const { request, dependencies } = requestHarness();
    process.env.OPENAI_API_KEY = "sk-test";
    createRequestHandler(
      OPENAI,
      5_000,
      dependencies,
    )(
      makeReq(
        "/openai/chat?stream=true",
        { host: "client", "content-type": "application/json" },
        "GET",
      ),
      makeRes(),
    );
    const options = requestOptions(request);
    expect(options).toMatchObject({
      path: "/v1/chat?stream=true",
      method: "GET",
      timeout: 5_000,
    });
    const headers = options.headers;
    expect(headers).toEqual(
      expect.objectContaining({
        "content-type": "application/json",
        authorization: "Bearer sk-test",
      }),
    );
    expect(headers).not.toHaveProperty("host");
  });

  it("injects query-token and basic authentication", () => {
    const queryRequest = vi.fn<ProxyRequestFunction>();
    queryRequest.mockImplementation((_options, callback) => {
      if (callback) return new FakeUpstream();
      return new FakeUpstream();
    });
    const queryDeps = makeDependencies(queryRequest);
    process.env.BROWSERLESS_TOKEN = "browserless-token";
    createRequestHandler(
      [
        {
          provider: "browserless",
          envVars: ["BROWSERLESS_TOKEN"],
          auth: { type: "query-token" },
          baseUrl: "https://browserless.test",
        },
      ],
      1,
      queryDeps,
    )(
      makeReq("/browserless/content?timeout=1", { authorization: "fake" }),
      makeRes(),
    );
    const queryOptions = requestOptions(queryRequest);
    expect(queryOptions.path).toBe(
      "/content?timeout=1&token=browserless-token",
    );
    expect(queryOptions.headers).not.toHaveProperty("authorization");

    const basicRequest = vi.fn<ProxyRequestFunction>();
    basicRequest.mockImplementation((_options, callback) => {
      if (callback) return new FakeUpstream();
      return new FakeUpstream();
    });
    const basicDeps = makeDependencies(basicRequest);
    process.env.GITHUB_TOKEN = "gh-token";
    createRequestHandler(
      [
        {
          provider: "git",
          envVars: ["GITHUB_TOKEN"],
          auth: { type: "basic" },
          baseUrl: "https://github.test",
        },
      ],
      1,
      { ...basicDeps, httpsRequest: basicRequest },
    )(makeReq("/git/repo"), makeRes());
    expect(requestOptions(basicRequest).headers).toEqual(
      expect.objectContaining({
        authorization: `Basic ${Buffer.from("x-access-token:gh-token").toString("base64")}`,
      }),
    );
  });

  it("returns gateway errors and destroys a response after headers", () => {
    const { request, upstream, dependencies } = requestHarness();
    const response = makeRes();
    createRequestHandler(
      OPENAI,
      1,
      dependencies,
    )(makeReq("/openai/v1"), response);
    upstream.emit("error", new Error("connection refused"));
    expect(response.writeHead).toHaveBeenCalledWith(502);
    expect(response.end).toHaveBeenCalledWith("Bad Gateway");

    const responseAfterHeaders = makeRes();
    Object.defineProperty(responseAfterHeaders, "headersSent", { value: true });
    createRequestHandler(
      OPENAI,
      1,
      dependencies,
    )(makeReq("/openai/v1"), responseAfterHeaders);
    const error = new Error("late failure");
    upstream.emit("error", error);
    expect(responseAfterHeaders.destroy).toHaveBeenCalledWith(error);
    expect(request).toHaveBeenCalled();
  });

  it("handles upstream response completion and timeout", () => {
    const { upstream, request, dependencies } = requestHarness();
    const response = makeRes();
    createRequestHandler(
      OPENAI,
      1,
      dependencies,
    )(makeReq("/openai/v1"), response);
    const callback = requestCallback(request);
    const upstreamResponse = new IncomingMessage(new Socket());
    upstreamResponse.statusCode = 200;
    upstreamResponse.headers = { "content-type": "application/json" };
    callback(upstreamResponse);
    expect(response.writeHead).toHaveBeenCalledWith(
      200,
      upstreamResponse.headers,
    );
    upstreamResponse.emit("end");

    upstream.emit("timeout");
    expect(upstream.destroySpy).toHaveBeenCalled();
  });
});

describe("credential proxy initialization", () => {
  it("initializes configured Google and Reddit credentials and starts server", async () => {
    const server = {
      on: vi.fn().mockReturnThis(),
      listen: vi.fn((_port: number, _host: string, cb: () => void) => cb()),
      address: vi.fn(() => ({ port: 12345 })),
    };
    const createServer = vi.fn<ProxyCreateServer>(() => server);
    const google: CredentialEntry = {
      provider: "google",
      baseUrl: "https://google.test",
      google: {
        clientId: "id",
        clientSecretEnvVar: "SECRET",
        scopes: ["scope"],
      },
    };
    const reddit: CredentialEntry = {
      provider: "reddit",
      baseUrl: "https://reddit.test",
      redditCookie: { cookieFile: "cookies", maxAgeDays: 1 },
    };
    process.env.SECRET = "secret";
    const initGoogleAuth = vi.fn().mockResolvedValue(undefined);
    const getGoogleAccessToken = vi.fn().mockResolvedValue("token");
    const getRedditCookieHeader = vi.fn().mockResolvedValue("cookie");
    const request = vi.fn<ProxyRequestFunction>();
    request.mockImplementation((_options, callback) => {
      if (callback) return new FakeUpstream();
      return new FakeUpstream();
    });
    const deps = makeDependencies(request, {
      createServer,
      loadCredentialProxy: vi.fn().mockResolvedValue([google, reddit]),
      initGoogleAuth,
      getGoogleAccessToken,
      getRedditCookieHeader,
    });
    await expect(initCredentialProxyServer(deps)).resolves.toBe(12345);
    expect(initGoogleAuth).toHaveBeenCalledWith(
      "google",
      google.google,
      "secret",
    );
    expect(getGoogleAccessToken).toHaveBeenCalledWith("google");
    expect(getRedditCookieHeader).toHaveBeenCalledWith(
      "reddit",
      reddit.redditCookie,
    );
  });
});
