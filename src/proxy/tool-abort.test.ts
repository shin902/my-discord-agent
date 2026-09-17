import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import { loadToolTimeoutMs } from "../config/tool-config.js";
import { resolveTools } from "../tools/registry.js";
import { requestToolProxy } from "../tools/tool-proxy.js";
import {
  createToolProxyRun,
  initToolProxyServer,
  stopToolProxyServer,
} from "./tool-proxy-server.js";

vi.mock("../config/credential-proxy.js", () => ({
  loadCredentialProxy: vi.fn(),
}));
vi.mock("../config/tool-config.js", () => ({ loadToolTimeoutMs: vi.fn() }));
vi.mock("../config/proxy-config.js", () => ({
  loadRequestTimeoutMs: vi.fn().mockResolvedValue(120_000),
}));

let upstream: Server;
let proxyUrl: string;

beforeEach(async () => {
  vi.mocked(loadToolTimeoutMs).mockResolvedValue(120_000);
  upstream = createServer();
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("no upstream port");
  vi.mocked(loadCredentialProxy).mockResolvedValue(
    ["google-calendar", "github", "graph"].map((provider) => ({
      provider,
      baseUrl: `http://127.0.0.1:${address.port}`,
    })),
  );
  proxyUrl = `http://127.0.0.1:${await initToolProxyServer()}/__tool-proxy/rpc`;
});
afterEach(async () => {
  await stopToolProxyServer();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

const createArgs = {
  summary: "fixture",
  start: "2026-01-01",
  end: "2026-01-02",
};

describe("Tool Proxy → host Tool → hostFetch → upstream cancellation", () => {
  it.each([
    "caller",
    "native-timeout",
    "proxy-timeout",
  ])("cancels delayed create-event on %s without a later local success", async (mode) => {
    if (mode === "proxy-timeout")
      vi.mocked(loadToolTimeoutMs).mockResolvedValue(100);
    let started!: () => void;
    const received = new Promise<void>((resolve) => {
      started = resolve;
    });
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    let committed = false;
    upstream.on("request", (req, res) => {
      expect(req.method).toBe("POST");
      req.resume();
      const commit = setTimeout(() => {
        committed = true;
        res.end(JSON.stringify({ id: "late-success" }));
      }, 2_000);
      res.on("close", () => {
        clearTimeout(commit);
        disconnected();
      });
      started();
    });
    const run = createToolProxyRun("calendar-abort", ["create-event"]);
    if (!run) throw new Error("no run");
    const endpoint = { url: proxyUrl, token: run.token };
    const caller = new AbortController();
    const [tool] = resolveTools(
      ["create-event"],
      {},
      { toolProxyEndpoint: endpoint, toolTimeoutMs: 100 },
    );
    const pending = (
      mode === "native-timeout"
        ? tool.execute("test", createArgs)
        : requestToolProxy("create-event", createArgs, endpoint, caller.signal)
    ).catch((error: unknown) => error);
    await received;
    if (mode === "caller") caller.abort(new Error("caller stopped"));
    expect(await pending).toBeInstanceOf(Error);
    await closed;
    expect(committed).toBe(false);
    run.revoke();
  });

  it.each([
    "caller",
    "proxy-timeout",
  ])("keeps the outer %s active across Calendar pagination", async (mode) => {
    if (mode === "proxy-timeout")
      vi.mocked(loadToolTimeoutMs).mockResolvedValue(100);
    let secondPage!: () => void;
    const received = new Promise<void>((resolve) => {
      secondPage = resolve;
    });
    let disconnected!: () => void;
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const paths: string[] = [];
    upstream.on("request", (req, res) => {
      paths.push(req.url ?? "");
      if (paths.length === 1) {
        res.end(JSON.stringify({ items: [], nextPageToken: "next" }));
      } else {
        res.on("close", disconnected);
        secondPage();
      }
    });
    const run = createToolProxyRun("pages", ["list-calendars"]);
    if (!run) throw new Error("no run");
    const caller = new AbortController();
    const pending = requestToolProxy(
      "list-calendars",
      {},
      { url: proxyUrl, token: run.token },
      caller.signal,
    ).catch((error: unknown) => error);
    await received;
    if (mode === "caller") caller.abort();
    expect(await pending).toBeInstanceOf(Error);
    await closed;
    expect(paths).toEqual([
      "/users/me/calendarList",
      "/users/me/calendarList?pageToken=next",
    ]);
    run.revoke();
  });
});
