import { loadDiscordConfig } from "../src/config/config.js";
import {
  DiscordCommandDeploymentError,
  deployDiscordCommandsToBots,
  resolveDiscordCommandDeployTargets,
} from "../src/discord/deploy-commands.js";

const [scope, guildId] = process.argv.slice(2);
if (scope !== "global" && scope !== "guild") {
  throw new Error("usage: pnpm discord:deploy [global|guild] [guild-id]");
}
if (scope === "guild" && !guildId) {
  throw new Error("guild deploy には guild-id 引数が必要です");
}
if (scope === "global" && guildId) {
  throw new Error("global deploy には guild-id 引数を指定できません");
}

const discordConfig = await loadDiscordConfig();
const targets = resolveDiscordCommandDeployTargets(discordConfig);
try {
  const results = await deployDiscordCommandsToBots({
    targets,
    scope,
    ...(guildId ? { guildId } : {}),
  });
  for (const result of results) {
    console.log(
      `[discord-command] bot=${result.botId} ${scope} deploy succeeded (${result.commandCount ?? 0} commands)`,
    );
  }
} catch (error) {
  if (!(error instanceof DiscordCommandDeploymentError)) throw error;
  for (const result of error.results) {
    if (result.status === "succeeded") {
      console.log(
        `[discord-command] bot=${result.botId} ${scope} deploy succeeded (${result.commandCount ?? 0} commands)`,
      );
    } else {
      console.error(
        `[discord-command] bot=${result.botId} ${scope} deploy failed: ${result.error ?? "unknown error"}`,
      );
    }
  }
  console.error(`[discord-command] ${error.message}`);
  process.exitCode = 1;
}
