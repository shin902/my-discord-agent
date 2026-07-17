import { z } from "zod";
import { loadRawProviders } from "./config.js";

export const ProviderConcurrencySchema = z.enum(["serial", "parallel"]);
export type ProviderConcurrency = z.infer<typeof ProviderConcurrencySchema>;

export const ProviderConfigSchema = z.object({
  provider: z.string().min(1),
  concurrency: ProviderConcurrencySchema,
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

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

let cache: ProviderConfig[] | null = null;

export async function loadProviders(): Promise<ProviderConfig[]> {
  if (cache !== null) return cache;
  cache = ProvidersConfigSchema.parse(await loadRawProviders());
  return cache;
}

/** 未設定 provider は安全側に倒して直列実行する。 */
export async function resolveProviderConcurrency(
  provider: string,
): Promise<ProviderConcurrency> {
  const entries = await loadProviders();
  return (
    entries.find((entry) => entry.provider === provider)?.concurrency ??
    "serial"
  );
}
