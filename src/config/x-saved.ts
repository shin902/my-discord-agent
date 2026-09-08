import { z } from "zod";
import { loadRawConfig } from "./config.js";

export const XSavedReceiverConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(8787),
});

export async function loadXSavedReceiverConfig() {
  const raw = await loadRawConfig();
  return XSavedReceiverConfigSchema.parse(
    raw.xSavedReceiver === undefined ? {} : raw.xSavedReceiver,
  );
}
