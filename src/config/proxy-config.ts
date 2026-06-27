import { z } from "zod";
import { loadRawConfig } from "./config.js";

const ProxyConfigSchema = z.object({
  requestTimeoutMs: z.number().int().positive().optional(),
});

// コンテナタイムアウト（10分）より十分短い値にすることで、
// API ハング時にサンドボックスがエラーで早期終了し LLM ロックを速やかに解放する
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export async function loadRequestTimeoutMs(): Promise<number> {
  const raw = await loadRawConfig();
  if (raw.proxy !== undefined) {
    const result = ProxyConfigSchema.safeParse(raw.proxy);
    if (result.success && result.data.requestTimeoutMs !== undefined) {
      return result.data.requestTimeoutMs;
    }
    if (!result.success) {
      console.warn(
        "[proxy] proxy 設定が不正、デフォルト使用:",
        result.error.message,
      );
    }
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}
