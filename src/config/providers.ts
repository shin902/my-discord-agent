import { z } from "zod";
import { loadRawProviders } from "./config.js";

export const ProviderConcurrencySchema = z.enum(["serial", "parallel"]);
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
    const resourceConcurrency = new Map<string, ProviderConcurrency>();
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.provider)) {
        ctx.addIssue({
          code: "custom",
          message: `provider が重複しています: ${entry.provider}`,
          path: [index, "provider"],
        });
      }
      seen.add(entry.provider);

      const resource = inferenceResourceKey(entry.provider, entry.resource);
      const existing = resourceConcurrency.get(resource);
      if (existing !== undefined && existing !== entry.concurrency) {
        ctx.addIssue({
          code: "custom",
          message: `resource の concurrency が一致しません: ${resource}`,
          path: [index, "concurrency"],
        });
      }
      resourceConcurrency.set(resource, entry.concurrency);
    }
  });

export async function loadProviders(): Promise<ProviderConfig[]> {
  return ProvidersConfigSchema.parse(await loadRawProviders());
}

export interface ProviderLockTarget {
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
    resource: inferenceResourceKey(provider, entry?.resource),
    concurrency: entry?.concurrency ?? "serial",
  };
}
