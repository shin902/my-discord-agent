import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { QueueRepository } from "../queue/repository.js";
import type { QueueProducer } from "../queue/types.js";

vi.mock("../config/bots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/bots.js")>()),
  loadBotRegistry: vi
    .fn()
    .mockResolvedValue({ research: { group: "group", instructions: "role" } }),
}));

import { enqueueCronInbox } from "./enqueue.js";

it("carries the noReply system-prompt option without changing content", async () => {
  const appendInbox = vi.fn();
  const base = {
    id: "job",
    client: {} as never,
    groupName: "group",
    channelId: "channel",
    deliveryMode: "direct" as const,
    historyMode: "fresh" as const,
    appendInbox,
  };

  await enqueueCronInbox({ ...base, noReply: true }, "prompt");
  expect(appendInbox).toHaveBeenLastCalledWith(
    expect.objectContaining({ cronNoReply: true, content: "prompt" }),
  );

  await enqueueCronInbox(base, "prompt");
  expect(appendInbox).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ cronNoReply: expect.anything() }),
  );
});

it.each([
  ["direct", "fresh"],
  ["direct", "full"],
  ["direct", "final-only"],
  ["new-thread", "fresh"],
  ["new-thread", "full"],
  ["new-thread", "final-only"],
  ["item-thread", "full"],
  ["item-thread", "final-only"],
] as const)("carries the explicit Bot through %s/%s", async (deliveryMode, historyMode) => {
  const appendInbox = vi.fn();
  await enqueueCronInbox(
    {
      id: "job",
      client: {} as never,
      groupName: "group",
      channelId: "channel",
      botId: "research",
      deliveryMode,
      historyMode,
      appendInbox,
      tools: [],
    },
    "prompt",
  );
  expect(appendInbox).toHaveBeenCalledWith(
    expect.objectContaining({
      botId: "research",
      groupName: "group",
      cronDeliveryMode: deliveryMode,
      cronHistoryMode: historyMode,
      configOverride: { tools: [] },
      sessionId:
        deliveryMode === "direct" && historyMode !== "fresh"
          ? "channel"
          : expect.stringMatching(/^cron-job-/),
    }),
  );
});

it.each([
  ["missing", "group"],
  ["research", "other"],
])("rejects invalid Bot %s in %s before enqueue", async (botId, groupName) => {
  const appendInbox = vi.fn();
  await expect(
    enqueueCronInbox(
      {
        id: "job",
        client: {} as never,
        groupName,
        channelId: "channel",
        botId,
        appendInbox,
      },
      "prompt",
    ),
  ).rejects.toThrow(/Bot/);
  expect(appendInbox).not.toHaveBeenCalled();
});

it.each([
  undefined,
  "research",
])("persists final-only history across queue restart for owner %s", async (botId) => {
  const dir = await mkdtemp(join(tmpdir(), "cron-context-"));
  const dbPath = join(dir, "runtime.sqlite");
  const repo = new QueueRepository(dbPath);
  let jobId = "";
  try {
    const appendInbox: QueueProducer = (input) => {
      jobId = repo.enqueue(input).job.id;
    };
    await enqueueCronInbox(
      {
        id: "job",
        groupName: "group",
        channelId: "channel",
        botId,
        deliveryMode: "direct",
        historyMode: "final-only",
        appendInbox,
      },
      "prompt",
    );
  } finally {
    repo.close();
  }
  const reopened = new QueueRepository(dbPath);
  try {
    expect(reopened.get(jobId)).toMatchObject({
      groupName: "group",
      sessionId: "channel",
      cronHistoryMode: "final-only",
    });
    expect(reopened.get(jobId)?.botId).toBe(botId);
  } finally {
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});
