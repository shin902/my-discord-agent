import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DISCORD_BOT_ID,
  destroyDiscordClients,
  getDefaultDiscordClient,
  getDiscordClient,
  getDiscordClientForGroup,
  getDiscordClientForGroupName,
  getDiscordClients,
  initDiscordClients,
} from "./client.js";
const config = () =>
  Promise.resolve({ bots: { takop: { tokenEnv: "TAKOP_BOT_TOKEN" } } });
const group = (name: string) =>
  Promise.resolve(
    name === "takop" ? { name, bot: "takop", channels: [] } : undefined,
  );

describe("Discord client registry", () => {
  beforeEach(async () => {
    await initDiscordClients(config);
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
    expect(getDiscordClientForGroup({ name: "takop", bot: "takop" })).toBe(
      getDiscordClient("takop"),
    );
  });

  it("group name resolves through group configuration", async () => {
    await expect(getDiscordClientForGroupName("takop", group)).resolves.toBe(
      getDiscordClient("takop"),
    );
    await expect(
      getDiscordClientForGroupName("missing", group),
    ).rejects.toThrow("グループが未定義です: missing");
  });

  it("unknown named bot fails instead of falling back", () => {
    expect(() =>
      getDiscordClientForGroup({ name: "unknown", bot: "missing" }),
    ).toThrow("Discord Bot が未定義です: missing");
  });
});
