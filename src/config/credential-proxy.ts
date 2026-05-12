import { readFile } from "node:fs/promises";
import { z } from "zod";

const CredentialEntrySchema = z.object({
  envVar: z.string(),
  baseUrl: z.string().url(),
  injectHeader: z.string(),
  injectFormat: z.string(),
});

export type CredentialEntry = z.infer<typeof CredentialEntrySchema>;

let cache: CredentialEntry[] | null = null;

export async function loadCredentialProxy(): Promise<CredentialEntry[]> {
  if (cache) return cache;
  try {
    const raw = await readFile("config/credential-proxy.json", "utf-8");
    cache = z.array(CredentialEntrySchema).parse(JSON.parse(raw));
  } catch {
    cache = [];
  }
  return cache;
}
