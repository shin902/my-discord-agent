import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AssistantMessage,
  completeSimple,
  getModel,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessage } from "../../agent/manager.js";
import { resolveModel } from "../../agent/model.js";
import { loadCredentialProxy } from "../../config/credential-proxy.js";
import { resolveModelConfig } from "../../config/default-model.js";
import { findGroupByName } from "../../config/groups.js";
import { resolveProviderLockTarget } from "../../config/providers.js";
import {
  registerScreenCaptureSource,
  summarizeScreenCaptureBatch,
} from "../../features/screen-capture-summary.js";
import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import { acquireInferenceLock } from "../../queue/inference-lock.js";
import { JobHandlers } from "../../queue/job-handlers.js";
import { processMessage } from "../../queue/poller.js";
import { QueueRepository } from "../../queue/repository.js";
import { SourceHandlers } from "../../queue/source-handlers.js";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";
import { markEphemeralCronSession } from "../session-retention.js";

const handler = (ctx: CronContext) =>
  summarizeScreenCaptureBatch(
    ctx as Parameters<typeof summarizeScreenCaptureBatch>[0],
  );

const queue = vi.hoisted(() => ({
  repository: undefined as QueueRepository | undefined,
}));
vi.mock("../../queue/repository.js", async (original) => ({
  ...(await original<typeof import("../../queue/repository.js")>()),
  getQueueRepository: () => queue.repository,
}));
const magick = vi.hoisted(() => ({
  invalidIds: new Set<string>(),
  errorCode: undefined as string | number | undefined,
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _command: string,
      args: string[],
      callback: (...args: unknown[]) => void,
    ) => {
      const invalid = [...magick.invalidIds].some((id) =>
        args.some((arg) => arg.endsWith(`/${id}.png`)),
      );
      const errorCode = magick.errorCode;
      callback(
        errorCode || invalid
          ? Object.assign(new Error("magick failed"), {
              code: errorCode ?? 1,
            })
          : null,
        "",
        invalid ? "improper image header @ error/png.c/ReadPNGImage/" : "",
      );
    },
  ),
}));
vi.mock("@earendil-works/pi-ai/compat", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-ai/compat")>()),
  completeSimple: vi.fn(),
}));
vi.mock("../../agent/model.js", () => ({ resolveModel: vi.fn() }));
vi.mock("../../agent/manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../session-retention.js", () => ({
  markEphemeralCronSession: vi.fn(),
}));
vi.mock("../../config/credential-proxy.js", () => ({
  loadCredentialProxy: vi.fn(),
}));
vi.mock("../../config/default-model.js", () => ({
  resolveModelConfig: vi.fn(),
}));
vi.mock("../../config/groups.js", async (original) => ({
  ...(await original<typeof import("../../config/groups.js")>()),
  findGroupByName: vi.fn(),
}));
vi.mock("../../config/providers.js", () => ({
  resolveProviderLockTarget: vi.fn(),
}));
vi.mock("../../queue/inference-lock.js", () => ({
  acquireInferenceLock: vi.fn(),
}));
vi.mock("../../proxy/credential-proxy-server.js", () => ({
  getProxyPort: () => 4242,
}));

const visionModel = { provider: "openai", modelId: "gpt-4o-mini" };
const memoryModel = { provider: "openai", modelId: "gpt-5" };
const agentConfig = {
  model: memoryModel,
  tools: ["read", "write"],
  approvalRequiredTools: ["write"],
  skills: ["memory"],
  mounts: [{ host: "data", container: "/data" }],
  contextFiles: [{ path: "memory/context.md", maxChars: 1000 }],
};
const ctx = {
  id: "screen-capture-summary",
  schedule: "5m",
  enabled: true,
  groupName: "logbook",
  handler: "jobs/screen-capture-summary.ts",
  ...agentConfig,
  settings: { visionModel, concurrency: 2, limit: 1 },
} as CronContext;
const model = getModel("openai", "gpt-4o-mini");

function result(text = "Editor work"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

vi.mock("../../agent/session.js", () => ({
  loadMessages: async () => [],
  sessionConversationPath: () => "test-session",
}));
vi.mock("../../config/group-config.js", () => ({
  loadGroupSystemPrompt: async () => undefined,
}));
vi.mock("../../discord/client.js", () => ({
  getDiscordClientForGroupName: vi.fn(() => {
    throw new Error("unexpected Discord access");
  }),
  getDiscordClients: () => new Map(),
}));

describe("screen capture queue pipeline", () => {
  let repository: QueueRepository;
  let sources: SourceHandlers;
  const resume = vi.fn();
  function jobs() {
    return repository.db
      .prepare("SELECT id FROM jobs ORDER BY rowid")
      .all()
      .map((row) => {
        const job = repository.get((row as { id: string }).id);
        if (!job) throw new Error("missing job");
        return job;
      });
  }
  async function runNext() {
    const job = repository.claim(
      "test",
      60000,
      new Date(Date.now() + 3600000),
    )?.job;
    if (!job) throw new Error("expected queued job");
    await processMessage(job, undefined, new JobHandlers(), sources);
    const updated = repository.get(job.id);
    if (!updated) throw new Error("missing job");
    return updated;
  }
  let directory: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    magick.invalidIds.clear();
    magick.errorCode = undefined;
    directory = await mkdtemp(path.join(os.tmpdir(), "screen-summary-"));
    vi.stubEnv(
      "SCREEN_CAPTURE_DB_PATH",
      path.join(directory, "captures.sqlite"),
    );
    vi.stubEnv("RUNTIME_DB_PATH", path.join(directory, "runtime.sqlite"));
    repository = new QueueRepository(path.join(directory, "runtime.sqlite"));
    sources = new SourceHandlers();
    registerScreenCaptureSource(sources, repository, resume);
    repository.registerSources(sources);
    queue.repository = repository;
    vi.mocked(resolveModel).mockResolvedValue(model);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
    ]);
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "logbook",
      channels: [],
      model: memoryModel,
    });
    vi.mocked(resolveModelConfig).mockImplementation(async (config) =>
      config
        ? { ...config, provider: config.provider ?? "openai" }
        : memoryModel,
    );
    vi.mocked(resolveProviderLockTarget).mockImplementation(
      async (provider) => ({ resource: provider, concurrency: "parallel" }),
    );
    vi.mocked(acquireInferenceLock).mockResolvedValue(vi.fn());
    vi.mocked(completeSimple).mockResolvedValue(result());
    vi.mocked(sendMessage).mockResolvedValue("updated");
  });

  afterEach(async () => {
    repository.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  function insert(count: number, start = 0) {
    const db = openScreenCaptureDb();
    try {
      return Array.from({ length: count }, (_, offset) => {
        const index = start + offset;
        const id = randomUUID();
        db.prepare(
          "INSERT INTO screen_captures (id, image, received_at) VALUES (?, ?, ?)",
        ).run(
          id,
          Buffer.from(`image-${index}`),
          `2026-09-12T00:00:${String(index).padStart(2, "0")}Z`,
        );
        return id;
      });
    } finally {
      db.close();
    }
  }

  function rows() {
    const db = openScreenCaptureDb();
    try {
      return db
        .prepare(
          "SELECT id, summary, accepted, completed_at FROM screen_captures ORDER BY received_at, id",
        )
        .all() as {
        id: string;
        summary: string | null;
        accepted: number | null;
        completed_at: string | null;
      }[];
    } finally {
      db.close();
    }
  }

  it("accepts a limit above 10", async () => {
    await expect(
      handler({
        ...ctx,
        settings: { visionModel, concurrency: 2, limit: 30 },
      }),
    ).resolves.toBe(false);
  });

  it("rejects removed settings.timeoutMs configuration", async () => {
    await expect(
      handler({
        ...ctx,
        settings: { visionModel, concurrency: 2, timeoutMs: 10 },
      }),
    ).rejects.toThrow();
  });

  it("summarizes images with settings.visionModel then gives text to the memory model", async () => {
    insert(2);
    vi.mocked(sendMessage).mockImplementationOnce(async (_group, sessionId) => {
      expect(markEphemeralCronSession).toHaveBeenCalledWith(
        "logbook",
        sessionId,
      );
      return "updated";
    });
    await handler({
      ...ctx,
      settings: { visionModel, concurrency: 2, limit: 2 },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(rows().every((row) => row.completed_at === null)).toBe(true);
    await runNext();
    expect(execFile).toHaveBeenCalledWith(
      "magick",
      ["identify", expect.stringMatching(/\.png$/)],
      expect.any(Function),
    );
    expect(resolveModel).toHaveBeenCalledWith("openai", "gpt-4o-mini");
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(markEphemeralCronSession).toHaveBeenCalledWith(
      "logbook",
      vi.mocked(sendMessage).mock.calls[0][1],
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "logbook",
      expect.stringMatching(/^screen-capture-/),
      expect.stringContaining("Editor work"),
      expect.objectContaining({
        agentId: "main",
        configOverride: agentConfig,
      }),
    );
    expect(vi.mocked(sendMessage).mock.calls[0][2]).not.toContain(".png");
    expect(
      rows().every(
        (row) =>
          row.summary === "Editor work" &&
          row.accepted === 1 &&
          row.completed_at,
      ),
    ).toBe(true);
  });

  it("keeps VLM summaries pending when memory update fails and reuses them", async () => {
    insert(1);
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("agent failed"));
    await handler(ctx);
    expect((await runNext()).status).toBe("retry_wait");
    expect(rows()[0]).toMatchObject({
      summary: "Editor work",
      completed_at: null,
    });

    vi.mocked(completeSimple).mockClear();
    await handler(ctx);
    expect(completeSimple).not.toHaveBeenCalled();
    expect(jobs()).toHaveLength(1);
    await runNext();
    expect(rows()[0].completed_at).not.toBeNull();
  });

  it("does nothing until a full batch is pending", async () => {
    insert(1);
    await handler({
      ...ctx,
      settings: { visionModel, concurrency: 2, limit: 2 },
    });

    expect(completeSimple).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(rows()[0].completed_at).toBeNull();
  });

  it("terminally rejects invalid captures without analyzing a partial batch", async () => {
    const ids = insert(2);
    magick.invalidIds.add(ids[0]);

    await handler({
      ...ctx,
      settings: { visionModel, concurrency: 2, limit: 2 },
    });

    expect(completeSimple).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(rows()).toEqual([
      expect.objectContaining({
        id: ids[0],
        accepted: 0,
        completed_at: expect.any(String),
      }),
      expect.objectContaining({ id: ids[1], completed_at: null }),
    ]);

    insert(1, 2);
    await handler({
      ...ctx,
      settings: { visionModel, concurrency: 2, limit: 2 },
    });
    expect(completeSimple).toHaveBeenCalledTimes(2);
  });

  it("does not complete captures when ImageMagick validation is unavailable", async () => {
    insert(1);
    magick.errorCode = "ENOENT";

    await expect(handler(ctx)).rejects.toMatchObject({ code: "ENOENT" });
    expect(rows()[0].completed_at).toBeNull();
  });

  it("leaves captures beyond the configured work budget pending", async () => {
    const ids = insert(3);
    await handler({
      ...ctx,
      settings: { visionModel, concurrency: 2, limit: 2 },
    });

    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(rows().find((row) => row.id === ids[2])).toMatchObject({
      summary: null,
      completed_at: null,
    });
  });

  it("propagates summary database write failures", async () => {
    insert(1);
    const db = openScreenCaptureDb();
    try {
      db.exec(`CREATE TRIGGER fail_summary_write
        BEFORE UPDATE OF summary ON screen_captures
        BEGIN SELECT RAISE(ABORT, 'summary storage failed'); END`);
    } finally {
      db.close();
    }

    await expect(handler(ctx)).rejects.toThrow("summary storage failed");
    expect(rows()[0]).toMatchObject({ summary: null, completed_at: null });
  });

  it("leaves the full batch pending when one VLM summary fails", async () => {
    insert(2);
    vi.mocked(completeSimple)
      .mockRejectedValueOnce(new Error("provider failure"))
      .mockResolvedValueOnce(result("success"));
    await handler({
      ...ctx,
      settings: { visionModel, concurrency: 2, limit: 2 },
    });

    expect(rows().every((row) => row.completed_at === null)).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("recreates all direct images from the DB for each attempt and cleans up", async () => {
    const ids = insert(12);
    const directories: string[] = [];
    vi.mocked(sendMessage).mockImplementation(
      async (_group, sessionId, _content, options) => {
        expect(markEphemeralCronSession).toHaveBeenCalledWith(
          "logbook",
          sessionId,
        );
        expect(options).toMatchObject({
          agentId: "main",
          configOverride: agentConfig,
        });
        expect(options?.imagePaths).toHaveLength(12);
        if (!options?.imagePaths) throw new Error("missing images");
        const directory = path.join(
          process.cwd(),
          "groups/logbook",
          path.dirname(options.imagePaths[0]).replace("/workspace/", ""),
        );
        directories.push(directory);
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        for (const [index, id] of ids.entries()) {
          expect(
            (await stat(path.join(directory, `${id}.png`))).mode & 0o777,
          ).toBe(0o600);
          expect(await readFile(path.join(directory, `${id}.png`))).toEqual(
            Buffer.from(`image-${index}`),
          );
        }
        if (directories.length === 1) throw new Error("agent failed");
        return "";
      },
    );
    expect(
      await handler({ ...ctx, settings: { mode: "direct", limit: 12 } }),
    ).toBe(false);
    expect(completeSimple).not.toHaveBeenCalled();
    expect(acquireInferenceLock).not.toHaveBeenCalled();
    expect(jobs()[0]).toMatchObject({
      discordOutput: "none",
      cronSessionMode: "per-run",
      channelId: "",
      feature: {
        kind: "screen-capture",
        input: { mode: "direct", captureIds: ids },
      },
    });
    expect(jobs()[0]).not.toHaveProperty("imagePaths");
    expect((await runNext()).status).toBe("retry_wait");
    expect(rows().every((row) => row.completed_at === null)).toBe(true);
    await expect(stat(directories[0])).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await runNext()).status).toBe("completed");
    expect(directories[0]).not.toBe(directories[1]);
    await expect(stat(directories[1])).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(rows().every((row) => row.accepted === 1 && row.completed_at)).toBe(
      true,
    );
    expect(resume).toHaveBeenCalledOnce();
    expect(repository.db.prepare("SELECT * FROM deliveries").all()).toEqual([]);
  });

  it("omits configOverride when the cron has no AgentConfig fields", async () => {
    insert(1);
    await handler({
      ...ctx,
      model: undefined,
      tools: undefined,
      approvalRequiredTools: undefined,
      skills: undefined,
      mounts: undefined,
      contextFiles: undefined,
      settings: { mode: "direct", limit: 1 },
    });

    expect(jobs()[0]).not.toHaveProperty("configOverride");
  });

  it("leaves direct-mode images pending when the memory agent fails", async () => {
    insert(1);
    vi.mocked(sendMessage).mockRejectedValue(new Error("agent failed"));

    await handler({ ...ctx, settings: { mode: "direct", limit: 1 } });
    expect((await runNext()).status).toBe("retry_wait");
    expect(resume).not.toHaveBeenCalled();
    expect(rows()[0].completed_at).toBeNull();
  });

  it("blocks additional batches through queued, claimed, running and retry_wait states", async () => {
    insert(3);
    const direct = { ...ctx, settings: { mode: "direct", limit: 1 } };
    await handler(direct);
    // Changing the batch size cannot bypass the group-wide active-job check.
    const changed = { ...ctx, settings: { mode: "direct", limit: 2 } };
    await handler(changed);
    const claim = repository.claim();
    if (!claim) throw new Error("missing claim");
    await handler(changed);
    repository.markRunning(claim.job.id, claim.fencingToken);
    await handler(changed);
    repository.failAttempt(
      claim.job.id,
      new Error("retry"),
      claim.fencingToken,
    );
    await handler(changed);
    expect(jobs()).toHaveLength(1);
    expect(rows().every((row) => row.completed_at === null)).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("advances to the next oldest full batch only after successful completion", async () => {
    const ids = insert(5);
    const config = { ...ctx, settings: { mode: "direct", limit: 2 } };
    resume.mockImplementation(() => {
      void handler(config);
    });
    await handler(config);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0].feature?.input).toMatchObject({
      captureIds: ids.slice(0, 2),
    });
    await runNext();
    await vi.waitFor(() => expect(jobs()).toHaveLength(2));
    expect(jobs()[1].feature?.input).toMatchObject({
      captureIds: ids.slice(2, 4),
    });
    await runNext();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
    expect(jobs()).toHaveLength(2);
    expect(
      rows()
        .filter((row) => row.completed_at === null)
        .map((row) => row.id),
    ).toEqual([ids[4]]);
  });

  it("rolls back a failed completion callback and permits re-enqueue with the same batch key", async () => {
    const ids = insert(2);
    const config = { ...ctx, settings: { mode: "direct", limit: 2 } };
    const db = openScreenCaptureDb();
    db.exec(`CREATE TRIGGER fail_completion BEFORE UPDATE OF completed_at ON screen_captures
      WHEN NEW.id = '${ids[1]}' BEGIN SELECT RAISE(ABORT, 'completion failed'); END`);
    db.close();
    await handler(config);
    const first = await runNext();
    expect(first.status).toBe("completed");
    expect(
      rows().every((row) => row.completed_at === null && row.accepted === null),
    ).toBe(true);
    expect(resume).not.toHaveBeenCalled();
    expect(jobs()).toHaveLength(1);
    const repair = openScreenCaptureDb();
    repair.exec("DROP TRIGGER fail_completion");
    repair.close();
    await handler(config); // Existing upload/startup entry point.
    expect(jobs()).toHaveLength(2);
    expect(jobs()[1].idempotencyKey).toBe(first.idempotencyKey);
    expect(jobs()[1].sessionId).not.toBe(first.sessionId);
    await runNext();
    expect(rows().every((row) => row.completed_at && row.accepted === 1)).toBe(
      true,
    );
  });

  it("leaves terminal failures pending without immediately creating another job", async () => {
    insert(1);
    const config = { ...ctx, settings: { mode: "direct", limit: 1 } };
    await handler(config);
    vi.mocked(sendMessage).mockRejectedValueOnce(
      new NonRetryableError("terminal failure"),
    );
    const first = await runNext();
    expect(first.status).toBe("dead_letter");
    expect(rows()[0].completed_at).toBeNull();
    expect(resume).not.toHaveBeenCalled();
    expect(jobs()).toHaveLength(1);
    await handler(config);
    expect(jobs()[1].idempotencyKey).toBe(first.idempotencyKey);
    await runNext();
    expect(rows()[0].accepted).toBe(1);
  });

  it("cleans partially prepared images when input preparation fails", async () => {
    const ids = insert(2);
    await handler({ ...ctx, settings: { mode: "direct", limit: 2 } });
    magick.invalidIds.add(ids[1]);
    expect((await runNext()).status).toBe("retry_wait");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      await readdir(
        path.join(process.cwd(), "groups/logbook/.screen-captures"),
      ),
    ).toEqual([]);
    expect(rows().every((row) => row.completed_at === null)).toBe(true);
  });

  it("rejects missing handler-specific configuration", async () => {
    await expect(handler({ ...ctx, settings: {} })).rejects.toThrow();
    await expect(
      handler({ ...ctx, settings: { mode: "direct", timeoutMs: 1 } }),
    ).rejects.toThrow();
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
