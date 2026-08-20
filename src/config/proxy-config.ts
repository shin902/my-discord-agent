import { z } from "zod";
import {
  loadConfigField,
  loadRawConfig,
  type JsonValue,
} from "./config.js";

const ProxyConfigSchema = z.object({
  requestTimeoutMs: z.number().int().positive().optional(),
});

// コンテナタイムアウト（10分）より十分短い値にすることで、
// API ハング時にサンドボックスがエラーで早期終了し LLM ロックを速やかに解放する
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export async function loadRequestTimeoutMs(
  loadConfig: () => Promise<Record<string, JsonValue>> = loadRawConfig,
): Promise<number> {
  const raw = await loadConfig();
  return loadConfigField(
    raw,
    "proxy",
    ProxyConfigSchema,
    "requestTimeoutMs",
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
}
