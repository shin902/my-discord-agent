import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDiscordConfig: vi.fn(),
  findGroupByName: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadDiscordConfig: mocks.loadDiscordConfig,
}));
vi.mock("../config/groups.js", () => ({
  findGroupByName: mocks.findGroupByName,
}));

const {
  DEFAULT_DISCORD_BOT_ID,
  destroyDiscordClients,
  getDefaultDiscordClient,
  getDiscordClient,
  getDiscordClientForGroup,
  getDiscordClientForGroupName,
  getDiscordClients,
  initDiscordClients,
} = await import("./client.js");

describe("Discord client registry", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.loadDiscordConfig.mockResolvedValue({
      bots: { takop: { tokenEnv: "TAKOP_BOT_TOKEN" } },
    });
    mocks.findGroupByName.mockResolvedValue({
      name: "takop",
      bot: "takop",
      channels: [],
    });
    await initDiscordClients();
  });

  afterEach(async () => {
    await destroyDiscordClients();
  });

  it("implicit default bot and additional bots are both registered", () => {
    expect(getDiscordClients().size).toBe(2);
    expect(getDiscordClient(DEFAULT_DISCORD_BOT_ID)).toBe(
      getDefaultDiscordClient(),
    );
    expect(getDiscordClient("takop")).not.toBe(getDefaultDiscordClient());
  });

  it("group bot selects the additional bot and omission selects default", () => {
    const defaultClient = getDefaultDiscordClient();
    expect(getDiscordClientForGroup({ name: "default" })).toBe(defaultClient);
    expect(
      getDiscordClientForGroup({ name: "takop", bot: "takop" }),
    ).toBe(getDiscordClient("takop"));
  });

  it("group name resolves through group configuration", async () => {
    await expect(getDiscordClientForGroupName("takop")).resolves.toBe(
      getDiscordClient("takop"),
    );
    mocks.findGroupByName.mockResolvedValue(undefined);
    await expect(getDiscordClientForGroupName("missing")).rejects.toThrow(
      "グループが未定義です: missing",
    );
  });

  it("unknown named bot fails instead of falling back", () => {
    expect(() =>
      getDiscordClientForGroup({ name: "unknown", bot: "missing" }),
    ).toThrow("Discord Bot が未定義です: missing");
  });
});
