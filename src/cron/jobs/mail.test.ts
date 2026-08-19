import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendMessage: vi.fn(),
  findGroupByName: vi.fn(),
  getProxyPort: vi.fn(),
  resolveModel: vi.fn(),
  resolveModelConfig: vi.fn(),
  runTextOnlyAgent: vi.fn(),
}));

vi.mock("../../agent/model.js", () => ({ resolveModel: mocks.resolveModel }));
vi.mock("../../agent/session.js", () => ({
  appendMessage: mocks.appendMessage,
}));
vi.mock("../../agent/textOnlyAgent.js", () => ({
  runTextOnlyAgent: mocks.runTextOnlyAgent,
}));
vi.mock("../../config/default-model.js", () => ({
  resolveModelConfig: mocks.resolveModelConfig,
}));
vi.mock("../../config/groups.js", () => ({
  findGroupByName: mocks.findGroupByName,
}));
vi.mock("../../proxy/credential-proxy-server.js", () => ({
  getProxyPort: mocks.getProxyPort,
}));

import type { CronContext } from "../runner.js";

function makeContext(channel: unknown): CronContext {
  return {
    id: "mail",
    schedule: "15m",
    enabled: true,
    handler: "jobs/mail.ts",
    groupName: "mail",
    channelId: "channel",
    appendInbox: vi.fn(),
    client: {
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    } as never,
  };
}

function mockEmail(fetchMock: ReturnType<typeof vi.fn>): void {
  fetchMock
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          value: [
            {
              id: "mail-1",
              subject: "件名",
              from: {
                emailAddress: { name: "送信者", address: "from@example.com" },
              },
            },
          ],
        }),
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ body: { contentType: "text", content: "本文" } }),
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));
}

describe("mail cron delivery boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findGroupByName.mockResolvedValue({ name: "mail" });
    mocks.resolveModelConfig.mockResolvedValue({
      provider: "test",
      modelId: "model",
    });
    mocks.resolveModel.mockResolvedValue({});
    mocks.getProxyPort.mockReturnValue(1234);
    mocks.appendMessage.mockResolvedValue(undefined);
  });

  it("正常な要約はDiscord送信後に既読化する", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockEmail(fetchMock);
    const send = vi.fn().mockResolvedValue({
      startThread: vi.fn().mockResolvedValue({ id: "thread", send: vi.fn() }),
    });
    const channel = { type: 0, send };
    mocks.runTextOnlyAgent.mockResolvedValue({
      text: "要約",
      agentMessage: { role: "assistant", content: [], stopReason: "stop" },
    });

    const { default: handler } = await import("./mail.js");
    await handler(makeContext(channel));

    expect(send).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://localhost:1234/graph/me/messages/mail-1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it.each([
    {
      text: "",
      agentMessage: { role: "assistant", content: [], stopReason: "stop" },
    },
    {
      text: "要約",
      agentMessage: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "failed",
      },
    },
  ])("不完全なassistant応答は送信・既読化しない", async ({
    text,
    agentMessage,
  }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mockEmail(fetchMock);
    const send = vi.fn();
    mocks.runTextOnlyAgent.mockResolvedValue({ text, agentMessage });

    const { default: handler } = await import("./mail.js");
    await handler(makeContext({ type: 0, send }));

    expect(send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
