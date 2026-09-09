import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";
import { runAgent } from "../sandbox/agent-execution.js";
import { createRequestHandler } from "./credential-proxy-server.js";

const servers: Server[] = [];

function codexToken(accountId: string): string {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  return `${encode(JSON.stringify({ alg: "none", typ: "JWT" }))}.${encode(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  )}.test-signature`;
}

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

it.each([
  {
    provider: "anthropic",
    key: "test-anthropic-key",
    placeholder: "local",
    header: "x-api-key",
  },
  {
    provider: "google",
    key: "test-google-key",
    placeholder: "local",
    header: "x-goog-api-key",
  },
  {
    provider: "openai",
    key: "test-openai-key",
    placeholder: "openai-placeholder",
    header: "authorization",
    expectedPath: "/responses",
  },
  {
    provider: "openai-codex",
    key: codexToken("host-account"),
    placeholder: codexToken("proxy-account"),
    header: "authorization",
    expectedPath: "/codex/responses",
    expectedAccountId: "host-account",
  },
  {
    provider: "anthropic",
    key: "sk-ant-oat-test-secret",
    placeholder: "sk-ant-oat-proxy-placeholder",
    header: "authorization",
  },
] as const)("forwards the actual $provider SDK request with host authentication ($header)", async ({
  provider,
  key,
  placeholder,
  header,
  expectedPath,
  expectedAccountId,
}) => {
  vi.stubEnv("PROVIDER_AUTH_TEST_KEY", key);
  let received:
    | { headers: IncomingHttpHeaders; url?: string; body: string }
    | undefined;
  const upstream = await listen(
    createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received = { headers: req.headers, url: req.url, body };
      // Capture the real wire request without contacting a provider or retrying.
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "fixture captured request" } }),
      );
    }),
  );
  const entry: CredentialEntry = {
    provider,
    baseUrl: upstream,
    envVars: ["PROVIDER_AUTH_TEST_KEY"],
  };
  const proxy = await listen(createServer(createRequestHandler([entry], 5000)));
  const builtIn =
    provider === "anthropic"
      ? getModel("anthropic", "claude-sonnet-4-5")
      : provider === "google"
        ? getModel("google", "gemini-2.5-flash")
        : provider === "openai"
          ? getModel("openai", "gpt-6-astra")
          : getModel("openai-codex", "gpt-6-astra");
  await streamSimple(
    { ...builtIn, baseUrl: `${proxy}/${provider}` },
    {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    },
    {
      apiKey: placeholder,
      maxTokens: 16,
      ...(provider === "openai-codex" ? { transport: "sse" as const } : {}),
    },
  ).result();
  expect(received).toBeDefined();
  if (expectedPath) expect(received?.url).toBe(expectedPath);
  expect(received?.headers[header]).toBe(
    header === "authorization" ? `Bearer ${key}` : key,
  );
  if (expectedAccountId) {
    expect(received?.headers["chatgpt-account-id"]).toBe(expectedAccountId);
  }
  expect(JSON.stringify(received)).not.toContain(
    placeholder === "local" ? '"local"' : placeholder,
  );
  if (provider === "anthropic" && header === "authorization") {
    expect(received?.headers["x-api-key"]).toBeUndefined();
    expect(received?.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(received?.body).toContain("You are Claude Code");
  } else if (header === "authorization") {
    expect(received?.headers["x-api-key"]).toBeUndefined();
  } else {
    expect(received?.headers.authorization).toBeUndefined();
  }
});

it("removes a Codex account header when the host token has no account claim", async () => {
  vi.stubEnv("PROVIDER_AUTH_TEST_KEY", "not-a-jwt");
  let received: IncomingHttpHeaders | undefined;
  const upstream = await listen(
    createServer(async (req, res) => {
      for await (const _chunk of req) {
        // Consume the request before sending the fixture response.
      }
      received = req.headers;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "fixture captured request" } }),
      );
    }),
  );
  const proxy = await listen(
    createServer(
      createRequestHandler(
        [
          {
            provider: "openai-codex",
            envVars: ["PROVIDER_AUTH_TEST_KEY"],
            baseUrl: upstream,
          },
        ],
        5000,
      ),
    ),
  );

  await streamSimple(
    {
      ...getModel("openai-codex", "gpt-6-astra"),
      baseUrl: `${proxy}/openai-codex`,
    },
    {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    },
    {
      apiKey: codexToken("sandbox-account"),
      maxTokens: 16,
      transport: "sse",
    },
  ).result();

  expect(received?.authorization).toBe("Bearer not-a-jwt");
  expect(received?.["chatgpt-account-id"]).toBeUndefined();
});

it("uses the production Agent stream through SSE and rewrites Codex auth at the proxy boundary", async () => {
  const hostToken = codexToken("host-account");
  vi.stubEnv("PROVIDER_AUTH_TEST_KEY", hostToken);
  let received:
    | { headers: IncomingHttpHeaders; url?: string; body: string }
    | undefined;
  const upstream = await listen(
    createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received = { headers: req.headers, url: req.url, body };
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "fixture captured request" } }),
      );
    }),
  );
  let upgradeCount = 0;
  const proxyServer = createServer(
    createRequestHandler(
      [
        {
          provider: "openai-codex",
          envVars: ["PROVIDER_AUTH_TEST_KEY"],
          baseUrl: upstream,
        },
      ],
      5000,
    ),
  );
  proxyServer.on("upgrade", (_req, socket) => {
    upgradeCount += 1;
    socket.destroy();
  });
  const proxy = await listen(proxyServer);
  const builtIn = getModel("openai-codex", "gpt-6-astra");
  const result = await runAgent({
    systemPrompt: "system",
    model: { ...builtIn, baseUrl: `${proxy}/openai-codex` },
    messages: [],
    tools: [],
    thinkingLevel: "off",
    prompt: "hello",
    convertToLlm: (messages: AgentMessage[]) =>
      messages as unknown as Message[],
    getApiKey: () => codexToken("sandbox-placeholder"),
  });

  expect(result.terminalStopReason).toBe("error");
  expect(upgradeCount).toBe(0);
  expect(received).toBeDefined();
  expect(received?.url).toBe("/codex/responses");
  expect(received?.headers.authorization).toBe(`Bearer ${hostToken}`);
  expect(received?.headers["chatgpt-account-id"]).toBe("host-account");
  expect(JSON.stringify(received)).not.toContain("sandbox-placeholder");
});
