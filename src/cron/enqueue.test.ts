import { expect, it, vi } from "vitest";
import { enqueueCronInbox } from "./enqueue.js";

const markEphemeralCronSession = vi.hoisted(() => vi.fn());
vi.mock("../agent/session.js", () => ({ markEphemeralCronSession }));

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
  expect(markEphemeralCronSession).toHaveBeenCalledWith(
    "group",
    expect.any(String),
  );
  expect(appendInbox).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ cronNoReply: expect.anything() }),
  );
  markEphemeralCronSession.mockClear();
  await enqueueCronInbox({ ...base, sessionMode: "destination" }, "prompt");
  expect(markEphemeralCronSession).not.toHaveBeenCalled();
});
