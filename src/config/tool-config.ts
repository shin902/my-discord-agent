import { z } from "zod";
import { DEFAULT_TOOL_TIMEOUT_MS } from "../tools/timeout.js";
import { loadConfigField, loadRawConfig } from "./config.js";

const ToolConfigSchema = z.object({
  timeoutMs: z.number().int().positive().max(2_147_483_647).optional(),
});

export async function loadToolTimeoutMs(): Promise<number> {
  return loadConfigField(
    await loadRawConfig(),
    "tool",
    ToolConfigSchema,
    "timeoutMs",
    DEFAULT_TOOL_TIMEOUT_MS,
  );
}
