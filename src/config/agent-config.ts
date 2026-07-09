import { z } from "zod";
import { loadConfigField, loadRawConfig } from "./config.js";

const AgentConfigSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
});

export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

// エージェントプロセス（sendMessage が起動するサンドボックスコンテナ）の
// タイムアウト時間
export async function loadAgentTimeoutMs(): Promise<number> {
  const raw = await loadRawConfig();
  return loadConfigField(
    raw,
    "agent",
    AgentConfigSchema,
    "timeoutMs",
    DEFAULT_AGENT_TIMEOUT_MS,
  );
}
