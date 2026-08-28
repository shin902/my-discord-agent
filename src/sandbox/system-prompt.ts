import { readFile } from "node:fs/promises";

// The group prompt backend currently uses this path. Keep that storage detail at
// the adapter boundary so session/runtime code only deals in system prompts.
const GROUP_SYSTEM_PROMPT_PATH = "/workspace/AGENTS.md";

/** Load the group's system prompt from the mounted workspace. */
export async function loadGroupSystemPrompt(): Promise<string | null> {
  try {
    return await readFile(GROUP_SYSTEM_PROMPT_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
