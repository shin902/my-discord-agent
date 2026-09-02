import { deployDiscordCommands } from "../src/discord/deploy-commands.js";

const [scope = "global", guildId] = process.argv.slice(2);
if (scope !== "global" && scope !== "guild") {
  throw new Error("usage: pnpm discord:deploy [global|guild] [guild-id]");
}
if (scope === "guild" && !guildId) {
  throw new Error("guild deploy には guild-id 引数が必要です");
}

const applicationId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!applicationId) {
  throw new Error("DISCORD_APPLICATION_ID が設定されていません");
}
if (!token) {
  throw new Error("DISCORD_BOT_TOKEN が設定されていません");
}

const commands = await deployDiscordCommands({
  applicationId,
  token,
  scope,
  ...(guildId ? { guildId } : {}),
});
console.log(
  `[discord-command] ${scope} command deploy succeeded (${commands.length} commands)`,
);
