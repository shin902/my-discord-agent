import { createServer, get, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createRequestHandler } from "./credential-proxy-server.js";

const servers: Server[] = [];
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

it.each([
  "success",
  "headers-timeout",
  "stream-timeout",
  "downstream-abort",
  "upstream-error",
])("logs one safe upstream timing record for %s", async (scenario) => {
  const logs: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    const record = JSON.parse(line);
    if (record.event === "upstream_request_timing") logs.push(record);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const upstream = await listen(
    createServer((_req, res) => {
      if (scenario === "headers-timeout") return;
      if (scenario === "upstream-error") {
        res.destroy();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-request-id": "upstream-123",
      });
      res.write("data: hello\n\n");
      if (scenario === "success") res.end("data: done\n\n");
    }),
  );
  const proxy = await listen(
    createServer(
      createRequestHandler(
        [{ provider: "openai", baseUrl: `${upstream}/v1` }],
        80,
      ),
    ),
  );
  const url = `${proxy}/openai/responses?token=do-not-log`;
  if (scenario === "downstream-abort") {
    await new Promise<void>((resolve) => {
      const request = get(url, (response) => {
        response.once("data", () => {
          response.destroy();
          resolve();
        });
      });
      request.on("error", () => resolve());
    });
  } else if (scenario === "stream-timeout") {
    await expect(
      fetch(url).then((response) => response.text()),
    ).rejects.toThrow();
  } else {
    const response = await fetch(url);
    expect(response.status).toBe(
      scenario === "success" ? 200 : scenario === "upstream-error" ? 502 : 504,
    );
    await response.text();
  }
  await vi.waitFor(() => expect(logs).toHaveLength(1));
  const record = logs[0];
  expect(record.outcome).toBe(
    {
      success: "success",
      "headers-timeout": "upstream-timeout",
      "stream-timeout": "upstream-timeout",
      "downstream-abort": "downstream-abort",
      "upstream-error": "upstream-error",
    }[scenario],
  );
  expect(record).toMatchObject({
    provider: "openai",
    route: "/v1/responses",
    timeoutMs: 80,
    method: "GET",
    headersSent: !["headers-timeout", "upstream-error"].includes(scenario),
  });
  expect(record.requestId).toEqual(expect.any(String));
  expect(record.startedAt).toEqual(expect.any(String));
  expect(record.durationMs).toEqual(expect.any(Number));
  expect(record.idleMsAtEnd).toEqual(expect.any(Number));
  if (!["headers-timeout", "upstream-error"].includes(scenario)) {
    expect(record.headersMs).toEqual(expect.any(Number));
    expect(record.firstChunkMs).toEqual(expect.any(Number));
    expect(record.lastChunkMs).toEqual(expect.any(Number));
    expect(record.responseBytes).toBeGreaterThan(0);
    expect(record.upstreamRequestId).toBe("upstream-123");
  }
  expect(JSON.stringify(record)).not.toContain("do-not-log");
});
