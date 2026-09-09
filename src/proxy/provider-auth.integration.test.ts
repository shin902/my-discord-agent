import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";
import { createRequestHandler } from "./credential-proxy-server.js";

const servers: Server[] = [];
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
      : getModel("google", "gemini-2.5-flash");
  await streamSimple(
    { ...builtIn, baseUrl: `${proxy}/${provider}` },
    {
      messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
    },
    { apiKey: placeholder, maxTokens: 16 },
  ).result();
  expect(received).toBeDefined();
  expect(received?.headers[header]).toBe(
    header === "authorization" ? `Bearer ${key}` : key,
  );
  expect(JSON.stringify(received)).not.toContain(
    placeholder === "local" ? '"local"' : placeholder,
  );
  if (header === "authorization") {
    expect(received?.headers["x-api-key"]).toBeUndefined();
    expect(received?.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(received?.body).toContain("You are Claude Code");
  } else {
    expect(received?.headers.authorization).toBeUndefined();
  }
});
