import type { Server } from "node:http";
import { loadScreenCaptureReceiverConfig } from "../config/screen-capture.js";
import { startScreenCaptureReceiver } from "../integrations/screen-capture/receiver.js";

/** Screen capture owns its receiver admission; summary and GC remain cron handlers. */
export async function startScreenCapture(): Promise<Server | undefined> {
  const config = await loadScreenCaptureReceiverConfig();
  if (!config.enabled) return undefined;
  return startScreenCaptureReceiver({ port: config.port });
}
