import { ChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronContext } from "../runner.js";

const mocks = vi.hoisted(() => ({
  appendMessage: vi.fn(),
  findGroupByName: vi.fn(),
  getProxyPort: vi.fn(),
  resolveModel: vi.fn(),
  resolveModelConfig: vi.fn(),
  runTextOnlyAgent: vi.fn(),
}));

vi.mock("../../agent/model.js", () => ({
  resolveModel: mocks.resolveModel,
}));
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

import handler from "./mail.js";

function makeContext(channel: unknown): CronContext {
  return {
    id: "mail",
    schedule: "15m",
    enabled: true,
    handler: "jobs/mail.ts",
    channelId: "channel-1",
    groupName: "mail",
    prompt: "要約してください",
    appendInbox: vi.fn(async () => undefined),
    client: {
      channels: {
        fetch: vi.fn(async () => channel),
      },
    } as unknown as CronContext["client"],
  };
}

describe("mail handler", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let channelSend: ReturnType<typeof vi.fn>;
  let startThread: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    channelSend = vi.fn();
    startThread = vi.fn();
    mocks.appendMessage.mockReset().mockResolvedValue(undefined);
    mocks.findGroupByName.mockReset().mockResolvedValue({
      name: "mail",
      channels: [],
    });
    mocks.getProxyPort.mockReset().mockReturnValue(12345);
    mocks.resolveModel.mockReset().mockResolvedValue({
      id: "model-1",
      provider: "zai",
    });
    mocks.resolveModelConfig.mockReset().mockResolvedValue({
      provider: "zai",
      modelId: "model-1",
    });
    mocks.runTextOnlyAgent.mockReset().mockResolvedValue({
      text: "部分的な要約",
      agentMessage: {
        role: "assistant",
        content: [{ type: "text", text: "部分的な要約" }],
        errorMessage: "upstream response failed",
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("errorMessage付きの部分的なassistant出力は送信・スレッド作成・既読化しない", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "message-1",
              subject: "重要なお知らせ",
              from: {
                emailAddress: {
                  name: "Alice",
                  address: "alice@example.com",
                },
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          body: { contentType: "text", content: "メール本文" },
        }),
      });
    const sentMessage = { startThread };
    const channel = {
      type: ChannelType.GuildText,
      send: channelSend.mockResolvedValue(sentMessage),
    };

    await handler(makeContext(channel));

    expect(mocks.runTextOnlyAgent).toHaveBeenCalledOnce();
    expect(channelSend).not.toHaveBeenCalled();
    expect(startThread).not.toHaveBeenCalled();
    expect(mocks.appendMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("isRead eq false");
    expect(fetchMock.mock.calls[1][0]).toContain("/me/messages/message-1");
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toBe(false);
  });
});
