import { z } from "zod";
import { loadRawConfig } from "./config.js";

export type DispatchMode = "serial" | "parallel-session";

const PollerConfigSchema = z.object({
  dispatchMode: z.enum(["serial", "parallel-session"]).optional(),
});

export async function loadDispatchMode(): Promise<DispatchMode> {
  const env = process.env.POLLER_DISPATCH_MODE;
  if (env === "serial" || env === "parallel-session") return env;
  if (env !== undefined) {
    console.warn(
      `[poller] 無効な POLLER_DISPATCH_MODE: "${env}"、デフォルト使用`,
    );
  }

  const raw = await loadRawConfig();
  if (raw.poller !== undefined) {
    const result = PollerConfigSchema.safeParse(raw.poller);
    if (result.success && result.data.dispatchMode !== undefined) {
      return result.data.dispatchMode;
    }
    if (!result.success) {
      console.warn("[poller] poller 設定が不正、デフォルト使用:", result.error.message);
    }
  }

  return "parallel-session";
}
