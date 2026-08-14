import type { Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDiscordConfig: vi.fn(),
  findGroupByChannelId: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadDiscordConfig: mocks.loadDiscordConfig,
}));
vi.mock("../config/groups.js", () => ({
  findGroupByChannelId: mocks.findGroupByChannelId,
}));

const {
  destroyDiscordClients,
  getDiscordClient,
  getDiscordClientForChannel,
  initDiscordClients,
} = await import("./client.js");

function groupForChannel(channelId: string) {
  if (channelId !== "configured-root") return null;
  return {
    group: {
      name: "takop",
      bot: "takop",
      channels: [],
    },
    channel: {
      channelId,
      sessionMode: "auto-thread" as const,
    },
  };
}

function replaceFetch(
  discordClient: Client,
  result: unknown,
): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(discordClient.channels, "fetch")
    .mockImplementation(async () => result as never);
}

function rejectFetch(
  discordClient: Client,
  error: Error,
): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(discordClient.channels, "fetch")
    .mockImplementation(async () => {
      throw error;
    });
}

describe("getDiscordClientForChannel", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.loadDiscordConfig.mockResolvedValue({
      defaultBot: "personal",
      bots: {
        personal: { tokenEnv: "DISCORD_BOT_TOKEN" },
        takop: { tokenEnv: "TAKOP_BOT_TOKEN" },
      },
    });
    mocks.findGroupByChannelId.mockImplementation(groupForChannel);
    await initDiscordClients();
  });

  afterEach(async () => {
    await destroyDiscordClients();
  });

  it("設定済みの直接チャンネルはそのグループのBotへ解決する", async () => {
    const personal = getDiscordClient("personal");
    const fetch = replaceFetch(personal, null);

    await expect(getDiscordClientForChannel("configured-root")).resolves.toBe(
      getDiscordClient("takop"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("キャッシュ済みスレッドは親チャンネルのグループBotへ解決する", async () => {
    const personal = getDiscordClient("personal");
    const takop = getDiscordClient("takop");
    const personalFetch = replaceFetch(personal, null);
    const takopFetch = replaceFetch(takop, null);
    personal.channels.cache.set("thread-1", {
      parentId: "configured-root",
    } as never);

    await expect(getDiscordClientForChannel("thread-1")).resolves.toBe(takop);
    expect(personalFetch).not.toHaveBeenCalled();
    expect(takopFetch).not.toHaveBeenCalled();
  });

  it("キャッシュにないスレッドはDiscordから取得して親を解決する", async () => {
    const personal = getDiscordClient("personal");
    const takop = getDiscordClient("takop");
    const personalFetch = replaceFetch(personal, {
      parentId: "configured-root",
    });
    const takopFetch = replaceFetch(takop, null);

    await expect(
      getDiscordClientForChannel("thread-after-restart"),
    ).resolves.toBe(takop);
    expect(personalFetch).toHaveBeenCalledWith("thread-after-restart");
    expect(takopFetch).not.toHaveBeenCalled();
  });

  it("デフォルトBotがスレッドを取得できなくても割り当てBotまで試す", async () => {
    const personal = getDiscordClient("personal");
    const takop = getDiscordClient("takop");
    const personalFetch = rejectFetch(personal, new Error("forbidden"));
    const takopFetch = replaceFetch(takop, {
      parentId: "configured-root",
    });

    await expect(
      getDiscordClientForChannel("thread-visible-to-takop"),
    ).resolves.toBe(takop);
    expect(personalFetch).toHaveBeenCalledWith("thread-visible-to-takop");
    expect(takopFetch).toHaveBeenCalledWith("thread-visible-to-takop");
  });

  it("未知のチャンネルはデフォルトBotへフォールバックする", async () => {
    const personal = getDiscordClient("personal");
    const takop = getDiscordClient("takop");
    const personalFetch = replaceFetch(personal, null);
    const takopFetch = replaceFetch(takop, null);

    await expect(getDiscordClientForChannel("unknown-channel")).resolves.toBe(
      personal,
    );
    expect(personalFetch).toHaveBeenCalledWith("unknown-channel");
    expect(takopFetch).toHaveBeenCalledWith("unknown-channel");
  });
});
