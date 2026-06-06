import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH =
  process.env.CONFIG_PATH ??
  path.join(__dirname, "../../config/config.json");

let _raw: Record<string, unknown> | null = null;

export async function loadRawConfig(): Promise<Record<string, unknown>> {
  if (_raw !== null) return _raw;
  try {
    const text = await readFile(CONFIG_PATH, "utf-8");
    _raw = JSON.parse(text) as Record<string, unknown>;
    return _raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      _raw = {};
      return _raw;
    }
    throw err;
  }
}
