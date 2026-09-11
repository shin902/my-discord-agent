import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { expectDefined } from "../test-utils.js";

const state = vi.hoisted(() => ({
  repository: undefined as unknown,
  loadRawCron: vi.fn(),
  client: {
    isReady: () => true,
    channels: {
      cache: { get: () => undefined },
      fetch: vi.fn().mockResolvedValue(null),
    },
  },
}));
vi.mock("../agent/manager.js", () => ({
  sendMessage: vi.fn().mockResolvedValue("normal response"),
}));
vi.mock("../config/config.js", async (original) => ({
  ...(await original<typeof import("../config/config.js")>()),
  loadRawCron: state.loadRawCron,
}));
vi.mock("../config/groups.js", async (original) => ({
  ...(await original<typeof import("../config/groups.js")>()),
  findGroupByName: vi.fn().mockResolvedValue({ name: "main", channels: [] }),
}));
vi.mock("../config/group-config.js", () => ({
  loadGroupSystemPrompt: vi.fn().mockResolvedValue(""),
}));
vi.mock("../config/default-model.js", () => ({
  resolveModelConfig: vi
    .fn()
    .mockResolvedValue({ provider: "test", modelId: "test" }),
}));
vi.mock("../config/providers.js", () => ({
  resolveProviderConcurrency: vi.fn().mockResolvedValue("parallel"),
}));
vi.mock("../discord/client.js", () => ({
  getDefaultDiscordClient: () => state.client,
  getDiscordClientForGroupName: async () => state.client,
  getDiscordClients: () => new Map([["personal", state.client]]),
}));
vi.mock("./repository.js", async (original) => ({
  ...(await original<typeof import("./repository.js")>()),
  getQueueRepository: () => state.repository,
}));

const root = await mkdtemp(join(tmpdir(), "memory-export-integration-"));
vi.stubEnv("SESSIONS_DIR", join(root, "sessions"));
const { appendMessage } = await import("../agent/session.js");
const { QueueRepository, openRuntimeDb } = await import("./repository.js");
const { _setCronJobs, loadAndValidateCron, executeJob } = await import(
  "../cron/runner.js"
);
const { processMessage } = await import("./poller.js");
const { sendMessage } = await import("../agent/manager.js");
let repo: InstanceType<typeof QueueRepository>;
const config = (id = "memory-main", settings = {}) => ({
  id,
  schedule: "1m",
  enabled: true,
  handler: "jobs/memory-export.ts",
  settings: {
    type: "tencentdb",
    eligibleGroups: ["main"],
    batchSize: 2,
    baseUrl: "http://127.0.0.1:8420",
    ...settings,
  },
});

async function startup(jobs = [config()]): Promise<void> {
  state.loadRawCron.mockResolvedValue(jobs);
  _setCronJobs(await loadAndValidateCron());
}
async function seed(id: string, group = "main"): Promise<void> {
  await appendMessage(
    group,
    "chat",
    { role: "user", content: `user ${id}`, timestamp: 1000 },
    { kind: "discord", sourceId: id, actorId: "human", messageType: 0 },
  );
  await appendMessage(group, "chat", {
    role: "assistant",
    content: [{ type: "text", text: `answer ${id}` }],
    stopReason: "stop",
    timestamp: 2000,
  } as AgentMessage);
}
async function processNext(now = new Date()): Promise<string> {
  const claimed = expectDefined(repo.claim("test-worker", 60_000, now));
  await processMessage(claimed.job);
  return claimed.job.id;
}
function accept(): Response {
  return new Response(JSON.stringify({ code: 0 }), { status: 200 });
}
function wireContents(fetchMock: {
  mock: { calls: Parameters<typeof fetch>[] };
}): string[] {
  return fetchMock.mock.calls.map(
    (call) =>
      JSON.parse(String((call[1] as RequestInit).body)).messages[0].content,
  );
}

beforeEach(async () => {
  vi.spyOn(process, "cwd").mockReturnValue(root);
  repo = new QueueRepository(openRuntimeDb(join(root, "runtime.sqlite")));
  state.repository = repo;
  await startup();
});
afterEach(async () => {
  repo.close();
  vi.restoreAllMocks();
  await rm(join(root, "sessions"), { recursive: true, force: true });
  await rm(join(root, "data"), { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"])
    await rm(join(root, `runtime.sqlite${suffix}`), { force: true });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("cron + runtime queue + canonical trajectory export", () => {
  it("cron only enqueues a minimal identity, with no conversation or settings snapshot", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await seed("one");
    await executeJob(config());
    const row = repo.db
      .prepare("SELECT payload_json,session_id FROM jobs")
      .get() as { payload_json: string; session_id: string };
    expect(row.session_id).toBe("memory-export:memory-main");
    expect(JSON.parse(row.payload_json)).toEqual({
      id: expect.any(String),
      retries: 0,
      enqueuedAt: expect.any(String),
      timestamp: expect.any(String),
      jobKind: "memory-export",
      cronJobId: "memory-main",
      sessionId: "memory-export:memory-main",
      channelId: "",
      groupName: "",
      content: "",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "jobs/memory-export.ts",
    "./jobs/memory-export.ts",
    "jobs/./memory-export.ts",
    "jobs//memory-export.ts",
    "jobs/memory-export.js",
    "./jobs/memory-export.js",
  ])("exports with loader-accepted handler identity %s", async (handler) => {
    const job = { ...config(), handler };
    await startup([job]);
    await seed("one");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => accept());
    await executeJob(job);
    expect(fetchMock).not.toHaveBeenCalled();
    const id = await processNext();
    expect(repo.get(id)?.status).toBe("completed");
    expect(wireContents(fetchMock)).toEqual(["user one"]);
    expect(repo.listDeliveries()).toEqual([]);
  });

  it("recovers an old claim after restart and uses only the new process cached settings", async () => {
    await seed("old-group");
    await seed("current-group", "private");
    await executeJob(config());
    const old = expectDefined(repo.claim("old-process", 1));
    repo.close();
    repo = new QueueRepository(openRuntimeDb(join(root, "runtime.sqlite")));
    state.repository = repo;
    await startup([
      config("memory-main", {
        eligibleGroups: ["private"],
        teamId: "current-team",
        baseUrl: "https://current.example",
      }),
    ]);
    // Disk changes after startup must not be re-read by the worker.
    state.loadRawCron.mockResolvedValue([
      config("memory-main", { teamId: "not-cached" }),
    ]);
    const calls = state.loadRawCron.mock.calls.length;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => accept());
    expect(await processNext(new Date(Date.now() + 60_000))).toBe(old.job.id);
    expect(repo.get(old.job.id)?.status).toBe("completed");
    expect(wireContents(fetchMock)).toEqual(["user current-group"]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://current.example/v3/conversation/add",
    );
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
      '"team_id":"current-team"',
    );
    expect(state.loadRawCron).toHaveBeenCalledTimes(calls);
    expect(() => repo.commitResult(old.job.id, old.fencingToken, "")).toThrow(
      /stale fencing/,
    );
  });

  it.each([
    "removed",
    "disabled",
    "repurposed",
  ])("terminally no-ops a %s cached cron identity", async (mode) => {
    await executeJob(config());
    const job = config();
    if (mode === "disabled") job.enabled = false;
    if (mode === "repurposed") job.handler = "./jobs/mail.ts";
    await startup(mode === "removed" ? [] : [job]);
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const id = await processNext();
    expect(repo.get(id)).toMatchObject({
      status: "completed",
      succeeded: true,
      deliverySuppressed: true,
    });
    expect(repo.listDeliveries()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serializes batches of one backend using existing session ordering, not other backends", async () => {
    await executeJob(config("a"));
    await executeJob(config("a"));
    await executeJob(config("b"));
    const first = expectDefined(repo.claim("worker-a"));
    const other = expectDefined(repo.claim("worker-b"));
    expect(first.job.cronJobId).toBe("a");
    expect(other.job.cronJobId).toBe("b");
    expect(repo.claim("worker-c")).toBeUndefined();
    repo.failAttempt(first.job.id, new Error("transient"), first.fencingToken);
    expect(repo.claim("worker-c")).toBeUndefined();
    repo.commitResult(other.job.id, other.fencingToken, "", {
      suppressDelivery: true,
    });
    const retry = expectDefined(
      repo.claim("retry", 60_000, new Date(Date.now() + 3_600_000)),
    );
    expect(retry.job.id).toBe(first.job.id);
    repo.commitResult(retry.job.id, retry.fencingToken, "", {
      suppressDelivery: true,
    });
    expect(repo.claim("next")?.job.cronJobId).toBe("a");
  });

  it("keeps partial success markers across retry/restart and bounds successful exports per batch", async () => {
    for (const id of ["one", "two", "three", "four"]) await seed(id);
    await executeJob(config());
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => accept())
      .mockRejectedValueOnce(new Error("network"))
      .mockImplementation(async () => accept());
    const id = await processNext();
    expect(repo.get(id)?.status).toBe("retry_wait");
    repo.close();
    repo = new QueueRepository(openRuntimeDb(join(root, "runtime.sqlite")));
    state.repository = repo;
    expect(await processNext(new Date(Date.now() + 3_600_000))).toBe(id);
    expect(wireContents(fetchMock)).toEqual([
      "user one",
      "user two",
      "user two",
      "user three",
    ]);
    await executeJob(config());
    await processNext();
    expect(wireContents(fetchMock).at(-1)).toBe("user four");
    await executeJob(config());
    await processNext();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    408, 429, 503, 400, 401,
  ])("routes HTTP %s through the standard queue failure contract", async (status) => {
    await seed("one");
    await executeJob(config());
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: status, message: "remote-secret" }), {
        status,
      }),
    );
    const id = await processNext();
    expect(repo.get(id)?.status).toBe(
      status >= 500 || status === 408 || status === 429
        ? "retry_wait"
        : "dead_letter",
    );
    expect(repo.get(id)?.lastError).not.toContain("remote-secret");
    expect(repo.listDeliveries()).toEqual([]);
  });

  it("dead-letters invalid cached settings without remote I/O", async () => {
    await startup([config("memory-main", { batchSize: 0 })]);
    await executeJob(config());
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const id = await processNext();
    expect(repo.get(id)).toMatchObject({
      status: "dead_letter",
      terminalReason: "non_retryable",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normal Discord response and durable delivery do not wait for or depend on a failing backend", async () => {
    await seed("one");
    await executeJob(config());
    const memory = expectDefined(repo.claim("memory"));
    let rejectFetch: (error: Error) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject;
        }),
    );
    const exporting = processMessage(memory.job);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const source = {
      kind: "discord" as const,
      sourceId: "two",
      actorId: "human",
      messageType: 19 as const,
    };
    const normal = repo.enqueue({
      groupName: "main",
      channelId: "channel",
      sessionId: "normal",
      content: "normal user",
      source,
      timestamp: new Date().toISOString(),
    }).job;
    const claimed = expectDefined(repo.claim("normal"));
    expect(claimed.job.id).toBe(normal.id);
    await processMessage(claimed.job);
    expect(repo.get(normal.id)?.status).toBe("completed");
    expect(repo.listDeliveries()).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "main",
      "normal",
      "normal user",
      expect.objectContaining({ source }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    rejectFetch(new Error("backend unavailable"));
    await exporting;
    expect(repo.get(memory.job.id)?.status).toBe("retry_wait");
    expect(repo.get(normal.id)?.status).toBe("completed");
    expect(repo.listDeliveries()[0]?.payloadJson).toContain("normal response");
  });
});
