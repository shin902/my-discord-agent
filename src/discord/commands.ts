import { command as botCommand } from "./commands/bot.js";
import { command as skillCommand } from "./commands/skill.js";

export type {
  DiscordCommand,
  DiscordCommandContext,
  DiscordCommandDefinition,
} from "./command-contract.js";
export {
  handleBotCommand,
  handleSkillCommand,
} from "./command-handlers.js";
export type { DiscordCommandSyncRetryOptions } from "./deploy-commands.js";
export {
  synchronizeDiscordCommands,
  synchronizeDiscordCommandsWithRetry,
} from "./deploy-commands.js";

/** @deprecated Import the command module or registry for new integrations. */
export const BOT_COMMAND = botCommand.data;
/** @deprecated Import the command module or registry for new integrations. */
export const SKILL_COMMAND = skillCommand.data;
