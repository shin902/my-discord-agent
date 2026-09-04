import { z } from "zod";
import { resolveAgentConfig } from "./agent-resolution.js";
import { validateAgentConfig } from "./agent-validation.js";
import { loadRawBots } from "./config.js";
import { AgentConfigSchema, type GroupConfig } from "./groups.js";

/** A persistent worker profile scoped to an AgentGroup. */
export const BotProfileSchema = AgentConfigSchema.extend({
  group: z.string().min(1),
  instructions: z.string().min(1),
});

export type BotProfile = z.infer<typeof BotProfileSchema>;

/** Named Bot profiles declared in the dedicated bots.json registry. */
export const BotRegistrySchema = z
  .record(z.string().min(1), BotProfileSchema)
  .default({});

export type BotRegistry = z.infer<typeof BotRegistrySchema>;

/** Resolve a Bot profile and enforce its AgentGroup boundary. */
export function resolveBotProfile(
  registry: BotRegistry,
  botId: string,
  groupName: string,
): BotProfile {
  const profile = Object.hasOwn(registry, botId) ? registry[botId] : undefined;
  if (!profile) throw new Error(`Bot が未定義です: ${botId}`);
  if (profile.group !== groupName) {
    throw new Error(`Bot ${botId} はグループ ${groupName} から利用できません`);
  }
  return profile;
}

/** Validate every Bot profile against its referenced AgentGroup at startup. */
export async function validateBotConfigs(
  groups: GroupConfig[],
  bots: BotRegistry,
  defaultModel: { provider: string; modelId: string },
): Promise<void> {
  await Promise.all(
    Object.entries(bots).map(async ([botId, profile]) => {
      const group = groups.find(
        (candidate) => candidate.name === profile.group,
      );
      if (!group) {
        throw new Error(
          `Bot ${botId} のグループが未定義です: ${profile.group}`,
        );
      }
      try {
        await validateAgentConfig(
          resolveAgentConfig(group, profile),
          defaultModel,
        );
      } catch (error) {
        throw new Error(
          `Bot ${botId} の設定が不正です: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }),
  );
}

export async function loadBotRegistry(): Promise<BotRegistry> {
  return BotRegistrySchema.parse(await loadRawBots());
}
