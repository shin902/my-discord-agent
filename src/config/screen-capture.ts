import { z } from "zod";
import { loadRawConfig } from "./config.js";

const ScreenCaptureReceiverConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(8788),
});

export async function loadScreenCaptureReceiverConfig() {
  const raw = await loadRawConfig();
  return ScreenCaptureReceiverConfigSchema.parse(
    raw.screenCaptureReceiver === undefined ? {} : raw.screenCaptureReceiver,
  );
}
