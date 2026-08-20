import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscordConfig, JsonValue } from "./config.js";

const originalConfigPath = process.env.CONFIG_PATH;
const originalDefaultToken = process.env.DISCORD_BOT_TOKEN;
const originalAdditionalToken = process.env.TAKOP_BOT_TOKEN;
const tempDirs: string[] = [];

async function loadDiscordConfig(
  raw: Record<string, JsonValue>,
  additionalToken?: string,
): Promise<DiscordConfig> {
  const dir = await mkdtemp(path.join(process.cwd(), "config-test-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(raw), "utf8");
  process.env.CONFIG_PATH = configPath;
  process.env.DISCORD_BOT_TOKEN = "default-token";
  if (additionalToken === undefined) delete process.env.TAKOP_BOT_TOKEN;
  else process.env.TAKOP_BOT_TOKEN = additionalToken;
  vi.resetModules();
  const config = await import("./config.js");
  return config.loadDiscordConfig();
}

afterEach(async () => {
  vi.resetModules();
  if (originalConfigPath === undefined) delete process.env.CONFIG_PATH;
  else process.env.CONFIG_PATH = originalConfigPath;
  if (originalDefaultToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = originalDefaultToken;
  if (originalAdditionalToken === undefined) delete process.env.TAKOP_BOT_TOKEN;
  else process.env.TAKOP_BOT_TOKEN = originalAdditionalToken;
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

describe("loadDiscordConfig", () => {
  it("legacy config without a discord section uses the implicit default", async () => {
    await expect(loadDiscordConfig({ defaultModel: {} })).resolves.toEqual({
      bots: {},
    });
  });

  it("omitted bots are treated as no additional bots", async () => {
    await expect(loadDiscordConfig({ discord: {} })).resolves.toEqual({
      bots: {},
    });
  });

  it("validates the default and additional bot token environments", async () => {
    await expect(
      loadDiscordConfig(
        { discord: { bots: { takop: { tokenEnv: "TAKOP_BOT_TOKEN" } } } },
        "takop-token",
      ),
    ).resolves.toEqual({
      bots: { takop: { tokenEnv: "TAKOP_BOT_TOKEN" } },
    });

    await expect(
      loadDiscordConfig({
        discord: { bots: { takop: { tokenEnv: "TAKOP_BOT_TOKEN" } } },
      }),
    ).rejects.toThrow(
      'Discord Bot "takop" の環境変数 TAKOP_BOT_TOKEN が設定されていません',
    );
  });
});
