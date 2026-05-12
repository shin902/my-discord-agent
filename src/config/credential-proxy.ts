import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "../../config/credential-proxy.json");

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
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = [];
      return cache;
    }
    throw err;
  }
  cache = z.array(CredentialEntrySchema).parse(JSON.parse(raw));
  return cache;
}
