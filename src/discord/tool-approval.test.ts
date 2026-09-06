import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchChannel = vi.hoisted(() => vi.fn());
const sendMessage = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({
  getDiscordClient: () => ({ channels: { fetch: fetchChannel } }),
}));

const {
  presentToolApprovalRequest,
  routeToolApprovalInteraction,
  TOOL_APPROVAL_UPDATE_TIMEOUT_MS,
} = await import("./tool-approval.js");
const { createToolApprovalRequest } = await import("../proxy/tool-approval.js");

function makeRequest(args: unknown = { eventId: "event-1" }) {
  return createToolApprovalRequest(
    {
      runId: "run-1",
      capability: "delete-event",
      trustedDiscordDestination: { botId: "personal", channelId: "channel-1" },
      revokeSignal: new AbortController().signal,
    },
    args,
  );
}

function customId(payload: { components?: unknown[] }, index: number): string {
  const rows = payload.components as Array<{
    components: Array<{ data: { custom_id: string } }>;
  }>;
  return rows[0]?.components[index]?.data.custom_id ?? "";
}

beforeEach(() => {
  fetchChannel.mockReset();
  sendMessage.mockReset().mockResolvedValue({ id: "message-1" });
  fetchChannel.mockResolvedValue({ send: sendMessage });
});

describe("presentToolApprovalRequest", () => {
  it("sends only the snapshotted tool and canonical args with approval buttons", async () => {
    const request = makeRequest({ eventId: "event-1" });

    await presentToolApprovalRequest(request);

    expect(fetchChannel).toHaveBeenCalledWith("channel-1");
    const payload = sendMessage.mock.calls[0]?.[0];
    expect(payload).toMatchObject({
      content: expect.stringContaining('"eventId": "event-1"'),
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(payload.content).not.toContain("run-1");
    expect(payload.content).not.toContain("personal");
    expect(customId(payload, 0)).toMatch(/^tool-approval:.+:approve$/);
    expect(customId(payload, 1)).toMatch(/^tool-approval:.+:deny$/);
  });

  it("reserves terminal suffix space at the 2000-character boundary", async () => {
    for (const [buttonIndex, result] of [
      [0, "approved"],
      [1, "denied"],
    ] as const) {
      const request = makeRequest({ value: "x".repeat(1_900) });
      await presentToolApprovalRequest(request);
      const payload = sendMessage.mock.calls.at(-1)?.[0];

      expect(payload.files).toBeUndefined();
      expect(payload.content.length).toBeLessThanOrEqual(2_000);
      const update = vi.fn().mockResolvedValue(undefined);
      await expect(
        routeToolApprovalInteraction(
          {
            customId: customId(payload, buttonIndex),
            user: { bot: false },
            channelId: "channel-1",
            message: { id: "message-1" },
            update,
          } as never,
          "personal",
        ),
      ).resolves.toBe(true);

      expect(update.mock.calls[0]?.[0].content.length).toBeLessThanOrEqual(
        2_000,
      );
      await expect(request.waitForDecision()).resolves.toBe(result);
    }

    const overflowing = makeRequest({ value: "x".repeat(1_910) });
    await presentToolApprovalRequest(overflowing);
    const attachmentPayload = sendMessage.mock.calls.at(-1)?.[0];
    expect(attachmentPayload.content.length).toBeLessThanOrEqual(2_000);
    expect(attachmentPayload.files).toHaveLength(1);
    expect(attachmentPayload.files[0].name).toBe("tool-approval-args.json");
  });

  it("attaches fenced JSON and does not replace the attachment on update", async () => {
    const request = makeRequest({ value: "x".repeat(2_000) });

    await presentToolApprovalRequest(request);
    const payload = sendMessage.mock.calls[0]?.[0];
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].name).toBe("tool-approval-args.json");

    const update = vi.fn().mockResolvedValue(undefined);
    const handled = await routeToolApprovalInteraction(
      {
        customId: customId(payload, 0),
        user: { bot: false },
        channelId: "channel-1",
        message: { id: "message-1" },
        update,
      } as never,
      "personal",
    );

    expect(handled).toBe(true);
    expect(update).toHaveBeenCalledOnce();
    const terminal = update.mock.calls[0]?.[0];
    expect(terminal.files).toBeUndefined();
    expect(terminal.attachments).toBeUndefined();
    expect(terminal.components[0].components[0].data.disabled).toBe(true);
    await expect(request.waitForDecision()).resolves.toBe("approved");

    const fenced = makeRequest({ value: "contains ``` fence" });
    await presentToolApprovalRequest(fenced);
    expect(sendMessage.mock.calls[1]?.[0].files).toHaveLength(1);
  });
});

describe("routeToolApprovalInteraction", () => {
  it("ignores mismatches and lets the first valid click win", async () => {
    const request = makeRequest();
    await presentToolApprovalRequest(request);
    const payload = sendMessage.mock.calls[0]?.[0];
    const id = customId(payload, 0);

    const base = {
      customId: id,
      user: { bot: false },
      channelId: "channel-1",
      message: { id: "message-1" },
      update: vi.fn().mockResolvedValue(undefined),
    };
    expect(
      await routeToolApprovalInteraction(
        { ...base, channelId: "other" } as never,
        "personal",
      ),
    ).toBe(false);
    expect(
      await routeToolApprovalInteraction(
        { ...base, user: { bot: true } } as never,
        "personal",
      ),
    ).toBe(false);
    expect(
      await routeToolApprovalInteraction(
        { ...base, message: { id: "other" } } as never,
        "personal",
      ),
    ).toBe(false);
    expect(await routeToolApprovalInteraction(base as never, "other-bot")).toBe(
      false,
    );
    expect(await routeToolApprovalInteraction(base as never, "personal")).toBe(
      true,
    );
    expect(
      await routeToolApprovalInteraction(
        { ...base, customId: customId(payload, 1) } as never,
        "personal",
      ),
    ).toBe(false);
    await expect(request.waitForDecision()).resolves.toBe("approved");
  });

  it("fails closed when the terminal update rejects", async () => {
    const request = makeRequest();
    await presentToolApprovalRequest(request);
    const payload = sendMessage.mock.calls[0]?.[0];
    const update = vi.fn().mockRejectedValue(new Error("timeout"));
    const edit = vi.fn();

    await routeToolApprovalInteraction(
      {
        customId: customId(payload, 0),
        user: { bot: false },
        channelId: "channel-1",
        message: { id: "message-1", edit },
        update,
      } as never,
      "personal",
    );

    await expect(request.waitForDecision()).rejects.toThrow(
      "Tool approval Discord update failed",
    );
    expect(request.claim("approve")).toBeUndefined();
    expect(edit).not.toHaveBeenCalled();
  });

  it("corrects a late successful update after timeout", async () => {
    vi.useFakeTimers();
    try {
      const request = makeRequest();
      await presentToolApprovalRequest(request);
      const payload = sendMessage.mock.calls[0]?.[0];
      let resolveUpdate!: () => void;
      const update = vi.fn(
        () => new Promise<void>((resolve) => (resolveUpdate = resolve)),
      );
      const edit = vi.fn().mockResolvedValue(undefined);
      const route = routeToolApprovalInteraction(
        {
          customId: customId(payload, 0),
          user: { bot: false },
          channelId: "channel-1",
          message: { id: "message-1", edit },
          update,
        } as never,
        "personal",
      );

      await vi.advanceTimersByTimeAsync(TOOL_APPROVAL_UPDATE_TIMEOUT_MS);
      await expect(request.waitForDecision()).rejects.toThrow(
        "Tool approval Discord update failed",
      );
      await expect(route).resolves.toBe(true);

      resolveUpdate();
      await Promise.resolve();
      await Promise.resolve();
      expect(edit).toHaveBeenCalledOnce();
      expect(edit.mock.calls[0]?.[0]).toMatchObject({
        content: expect.stringContaining("Tool approval failed / cancelled"),
        components: expect.any(Array),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a failed late correction without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      const request = makeRequest();
      await presentToolApprovalRequest(request);
      const payload = sendMessage.mock.calls[0]?.[0];
      let resolveUpdate!: () => void;
      const update = vi.fn(
        () => new Promise<void>((resolve) => (resolveUpdate = resolve)),
      );
      const edit = vi.fn().mockRejectedValue(new Error("edit failed"));
      const route = routeToolApprovalInteraction(
        {
          customId: customId(payload, 0),
          user: { bot: false },
          channelId: "channel-1",
          message: { id: "message-1", edit },
          update,
        } as never,
        "personal",
      );

      await vi.advanceTimersByTimeAsync(TOOL_APPROVAL_UPDATE_TIMEOUT_MS);
      await route;
      resolveUpdate();
      await Promise.resolve();
      await Promise.resolve();
      expect(edit).toHaveBeenCalledOnce();
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      vi.useRealTimers();
    }
  });
});
