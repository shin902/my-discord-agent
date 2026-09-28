import { expect, it, vi } from "vitest";
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
