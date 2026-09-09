import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const { readFile } = await import("node:fs/promises");
const originalPersonalToken = process.env.DISCORD_BOT_TOKEN;
const originalAdditionalToken = process.env.TAKOP_BOT_TOKEN;

async function loadDiscordConfig(
  raw: unknown,
  additionalToken?: string,
  personalToken: string | null = "personal-token",
): Promise<unknown> {
  if (personalToken === null) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = personalToken;
  if (additionalToken === undefined) delete process.env.TAKOP_BOT_TOKEN;
  else process.env.TAKOP_BOT_TOKEN = additionalToken;
  vi.resetModules();
  const config = await import("./config.js");
  vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(raw));
  return config.loadDiscordConfig();
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (originalPersonalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
  else process.env.DISCORD_BOT_TOKEN = originalPersonalToken;
  if (originalAdditionalToken === undefined) delete process.env.TAKOP_BOT_TOKEN;
  else process.env.TAKOP_BOT_TOKEN = originalAdditionalToken;
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
