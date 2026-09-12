import { z } from "zod";
import { loadRawConfig } from "./config.js";

export const XSavedReceiverConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(8787),
});

export const XSavedGalleryConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65535).default(8789),
    origin: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.hostname.endsWith(".ts.net") &&
          url.origin === value
        );
      }, "Expected an HTTPS Tailscale origin without a path")
      .optional(),
    allowedLogin: z
      .string()
      .min(1)
      .max(320)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .refine(
    (config) => !config.enabled || (!!config.origin && !!config.allowedLogin),
    "Enabled gallery requires origin and allowedLogin",
  );

export async function loadXSavedGalleryConfig() {
  const raw = await loadRawConfig();
  return XSavedGalleryConfigSchema.parse(
    raw.xSavedGallery === undefined ? {} : raw.xSavedGallery,
  );
}

export async function loadXSavedReceiverConfig() {
  const raw = await loadRawConfig();
  return XSavedReceiverConfigSchema.parse(
    raw.xSavedReceiver === undefined ? {} : raw.xSavedReceiver,
  );
}
