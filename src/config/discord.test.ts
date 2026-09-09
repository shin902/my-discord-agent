import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalConfigPath = process.env.CONFIG_PATH;
const originalPersonalToken = process.env.DISCORD_BOT_TOKEN;
const originalAdditionalToken = process.env.TAKOP_BOT_TOKEN;
const tempDirs: string[] = [];

async function loadDiscordConfig(
  raw: unknown,
  additionalToken?: string,
  personalToken: string | null = "personal-token",
): Promise<unknown> {
  const dir = await mkdtemp(path.join(process.cwd(), "config-test-"));
  tempDirs.push(dir);
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(raw), "utf8");
  process.env.CONFIG_PATH = configPath;
  if (personalToken === null) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = personalToken;
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
  if (originalPersonalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = originalPersonalToken;
  if (originalAdditionalToken === undefined) delete process.env.TAKOP_BOT_TOKEN;
  else process.env.TAKOP_BOT_TOKEN = originalAdditionalToken;
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs.length = 0;
});

describe("loadDiscordConfig", () => {
  it("requires an explicit personal Bot configuration", async () => {
    await expect(loadDiscordConfig({ defaultModel: {} })).rejects.toThrow();
    await expect(loadDiscordConfig({ discord: {} })).rejects.toThrow();
    await expect(loadDiscordConfig({ discord: { bots: {} } })).rejects.toThrow(
      'Discord Bot "personal" の設定がありません',
    );
  });

  it("validates every configured Bot token environment", async () => {
    const personal = {
      applicationId: "personal-application",
      tokenEnv: "DISCORD_BOT_TOKEN",
    };
    await expect(
      loadDiscordConfig(
        {
          discord: {
            bots: {
              personal,
              takop: {
                tokenEnv: "TAKOP_BOT_TOKEN",
                applicationId: "takop-application",
              },
            },
          },
        },
        "takop-token",
      ),
    ).resolves.toEqual({
      bots: {
        personal,
        takop: {
          ...personal,
          tokenEnv: "TAKOP_BOT_TOKEN",
          applicationId: "takop-application",
        },
      },
    });

    await expect(
      loadDiscordConfig(
        {
          discord: { bots: { personal } },
        },
        undefined,
        null,
      ),
    ).rejects.toThrow(
      'Discord Bot "personal" の環境変数 DISCORD_BOT_TOKEN が設定されていません',
    );
  });

  it("requires a non-secret application ID for every Bot", async () => {
    await expect(
      loadDiscordConfig({
        discord: {
          bots: {
            personal: { tokenEnv: "DISCORD_BOT_TOKEN" },
          },
        },
      }),
    ).rejects.toThrow();
  });
});
