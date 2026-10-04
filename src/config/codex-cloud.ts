import { z } from "zod";
import { loadRawConfig } from "./config.js";

export const CodexCloudConfigSchema = z.strictObject({
  allowedEnvironments: z.array(z.string().min(1)).default([]),
});

export async function loadCodexCloudConfig() {
  const raw = await loadRawConfig();
  return CodexCloudConfigSchema.parse(
    raw.codexCloud === undefined ? {} : raw.codexCloud,
  );
}
