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

// Delivery fields must stay aligned with CronDeliveryMode because the daily
// summary is enqueued through enqueueCronInbox. The item-thread/historyMode
// contract is checked at startup as well: historyMode defaults to "fresh",
// and an enqueue-time rejection would only be logged by the summary consumer.
const DailySummaryConfigSchema = AgentConfigSchema.extend({
  enabled: z.boolean().default(false),
  groupName: z.string().min(1),
  botId: z.string().min(1).optional(),
  startDate: z.iso.date(),
  prompt: z.string().trim().min(1),
  channelId: z.string().min(1),
  deliveryMode: z
    .enum(["direct", "new-thread", "item-thread"])
    .default("direct"),
  historyMode: z.enum(["fresh", "full"]).default("fresh"),
})
  .strict()
  .refine(
    ({ deliveryMode, historyMode }) =>
      deliveryMode !== "item-thread" || historyMode === "full",
    {
      path: ["historyMode"],
      message: "item-thread は historyMode=full と組み合わせてください",
    },
  );

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
