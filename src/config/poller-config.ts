import { z } from "zod";
import { loadRawConfig } from "./config.js";

export type DispatchMode = "serial" | "parallel-session";

const PollerConfigSchema = z.object({
  dispatchMode: z.enum(["serial", "parallel-session"]).optional(),
});

export async function loadDispatchMode(): Promise<DispatchMode> {
  const env = process.env.POLLER_DISPATCH_MODE;
  if (env === "serial" || env === "parallel-session") return env;

  const raw = await loadRawConfig();
  if (raw.poller !== undefined) {
    const parsed = PollerConfigSchema.parse(raw.poller);
    if (parsed.dispatchMode !== undefined) return parsed.dispatchMode;
  }

  return "parallel-session";
}
