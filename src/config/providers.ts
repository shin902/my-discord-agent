import { z } from "zod";
import { loadRawProviders } from "./config.js";

export const ProviderConcurrencySchema = z.union([
  z.enum(["serial", "parallel"]),
  z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
]);
export type ProviderConcurrency = z.infer<typeof ProviderConcurrencySchema>;

export const ProviderConfigSchema = z.object({
  provider: z.string().min(1),
  resource: z.string().min(1).optional(),
  concurrency: ProviderConcurrencySchema,
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

function inferenceResourceKey(provider: string, resource?: string): string {
  return resource ? `resource:${resource}` : `provider:${provider}`;
}

const ProvidersConfigSchema = z
  .array(ProviderConfigSchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.provider)) {
        ctx.addIssue({
          code: "custom",
          message: `provider が重複しています: ${entry.provider}`,
          path: [index, "provider"],
        });
      }
      seen.add(entry.provider);
    }
  });

let providersSnapshot: Promise<ProviderConfig[]> | undefined;

/** Startup validates and pins execution policies until the host restarts. */
export function loadProviders(): Promise<ProviderConfig[]> {
  providersSnapshot ??= loadRawProviders().then((raw) =>
    ProvidersConfigSchema.parse(raw),
  );
  return providersSnapshot;
}

export interface ProviderLockTarget {
  provider: string;
  resource: string;
  concurrency: ProviderConcurrency;
}

/** resource未指定providerは専用keyへ隔離し、安全側の直列実行にする。 */
export async function resolveProviderLockTarget(
  provider: string,
): Promise<ProviderLockTarget> {
  const entry = (await loadProviders()).find(
    (candidate) => candidate.provider === provider,
  );
  return {
    provider,
    resource: inferenceResourceKey(provider, entry?.resource),
    concurrency: entry?.concurrency ?? "serial",
  };
}
