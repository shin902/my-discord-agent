import { expect, it, vi } from "vitest";

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
    sessionMode: "per-run" as const,
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
  ["direct", "per-run"],
  ["direct", "destination"],
  ["new-thread", "per-run"],
  ["new-thread", "destination"],
  ["item-thread", "destination"],
] as const)("carries the explicit Bot through %s/%s", async (deliveryMode, sessionMode) => {
  const appendInbox = vi.fn();
  await enqueueCronInbox(
    {
      id: "job",
      client: {} as never,
      groupName: "group",
      channelId: "channel",
      botId: "research",
      deliveryMode,
      sessionMode,
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
      cronSessionMode: sessionMode,
      configOverride: { tools: [] },
      sessionId:
        deliveryMode === "direct" && sessionMode === "destination"
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
