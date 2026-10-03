import { z } from "zod";
import { loadRawConfig } from "./config.js";
import { AgentConfigSchema, ModelConfigSchema } from "./groups.js";

const ScreenCaptureReceiverConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(8788),
});

const CommonSettings = { limit: z.number().int().min(1).default(10) };
export const ScreenCaptureSettings = z.union([
  z.strictObject({ mode: z.literal("direct"), ...CommonSettings }),
  z.strictObject({
    mode: z.literal("summarize").default("summarize"),
    visionModel: ModelConfigSchema,
    concurrency: z.number().int().min(1).max(16).default(4),
    ...CommonSettings,
  }),
]);

const SummaryConfigSchema = AgentConfigSchema.extend({
  enabled: z.boolean().default(false),
  groupName: z.string().min(1),
  settings: ScreenCaptureSettings,
}).strict();

export type ScreenCaptureSummaryConfig = z.infer<typeof SummaryConfigSchema>;

export async function loadScreenCaptureSummaryConfig(): Promise<
  ScreenCaptureSummaryConfig | undefined
> {
  const raw = await loadRawConfig();
  if (raw.screenCaptureSummary === undefined) return undefined;
  const config = SummaryConfigSchema.parse(raw.screenCaptureSummary);
  return config.enabled ? config : undefined;
}

export async function loadScreenCaptureReceiverConfig() {
  const raw = await loadRawConfig();
  return ScreenCaptureReceiverConfigSchema.parse(
    raw.screenCaptureReceiver === undefined ? {} : raw.screenCaptureReceiver,
  );
}

const DailySummaryConfigSchema = AgentConfigSchema.extend({
  enabled: z.boolean().default(false),
  groupName: z.string().min(1),
  startDate: z.iso.date(),
  prompt: z.string().trim().min(1),
  channelId: z.string().min(1),
  deliveryMode: z.enum(["direct", "new-thread"]).default("direct"),
  sessionMode: z.enum(["per-run", "destination"]).default("per-run"),
}).strict();

export type ScreenCaptureDailySummaryConfig = z.infer<
  typeof DailySummaryConfigSchema
>;

export async function loadScreenCaptureDailySummaryConfig(): Promise<
  ScreenCaptureDailySummaryConfig | undefined
> {
  const raw = await loadRawConfig();
  if (raw.screenCaptureDailySummary === undefined) return undefined;
  const config = DailySummaryConfigSchema.parse(raw.screenCaptureDailySummary);
  return config.enabled ? config : undefined;
}
