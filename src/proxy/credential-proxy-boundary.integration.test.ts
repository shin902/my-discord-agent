import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";
import { createRequestHandler } from "./credential-proxy-server.js";

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No TCP address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
});

describe("LLM-only Credential Proxy surface (#205 / #386)", () => {
  it("never forwards integration routes, even with a valid LLM placeholder and no Tool Proxy approval", async () => {
    const upstreamRequests = vi.fn();
    const upstream = await listen(
      createServer((_req, res) => {
        upstreamRequests();
        res.end("credential-backed operation");
      }),
    );
    vi.stubEnv("BOUNDARY_SECRET", "host-only-secret");
    const integrations = [
      "github",
      "tavily",
      "google-calendar",
      "graph",
      "reddit",
      "new-integration",
      "renamed-github",
    ];
    const creds: CredentialEntry[] = integrations.map((provider) => ({
      provider,
      baseUrl: upstream,
      envVars: ["BOUNDARY_SECRET"],
    }));
    creds.push({
      provider: "openai",
      baseUrl: upstream,
      envVars: ["BOUNDARY_SECRET"],
    });
    const proxy = await listen(createServer(createRequestHandler(creds, 1000)));
    for (const provider of integrations) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const response = await fetch(`${proxy}/${provider}/operation`, {
          method,
          headers: {
            authorization: "Bearer local",
            "x-agent-internal-token": "guess",
          },
        });
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain("host-only-secret");
      }
    }
    expect(upstreamRequests).not.toHaveBeenCalled();
    expect((await fetch(`${proxy}/openai/responses`)).status).toBe(200);
    expect(upstreamRequests).toHaveBeenCalledOnce();
  });

  it.each([
    "openai",
    "openai-codex",
    "custom-gateway",
    "anthropic",
    "google",
  ])("transparently forwards %s Responses with only host credential replacement", async (provider) => {
    vi.stubEnv("BOUNDARY_SECRET", "gateway-or-direct-api-key");
    const body =
      '{"model":"fixture-model","reasoning":{"effort":"high"},"tools":[{"type":"function","name":"fixture"}],"stream":true}';
    const stream = 'event: response.completed\ndata: {"unchanged":true}\n\n';
    const observed: { url?: string; authorization?: string; body?: string } =
      {};
    const upstream = await listen(
      createServer(async (req, res) => {
        observed.url = req.url;
        observed.authorization = req.headers.authorization;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        observed.body = Buffer.concat(chunks).toString();
        res.writeHead(201, {
          "content-type": "text/event-stream",
          "x-fixture": "preserved",
        });
        res.end(stream);
      }),
    );
    const proxy = await listen(
      createServer(
        createRequestHandler(
          [
            {
              provider,
              api: "openai-responses",
              baseUrl: `${upstream}/v1`,
              envVars: ["BOUNDARY_SECRET"],
            },
          ],
          1000,
        ),
      ),
    );
    const response = await fetch(`${proxy}/${provider}/responses?fixture=1`, {
      method: "POST",
      headers: {
        authorization: "Bearer local",
        "content-type": "application/json",
      },
      body,
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-fixture")).toBe("preserved");
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(stream);
    expect(observed).toEqual({
      url: "/v1/responses?fixture=1",
      authorization: "Bearer gateway-or-direct-api-key",
      body,
    });
  });
});
