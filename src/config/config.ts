import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH =
  process.env.CONFIG_PATH ?? path.join(__dirname, "../../config/config.json");
export const GROUPS_PATH =
  process.env.GROUPS_PATH ?? path.join(__dirname, "../../config/groups.json");
export const CREDENTIALS_PATH =
  process.env.CREDENTIALS_PATH ??
  path.join(__dirname, "../../config/credentials.json");
export const CRON_PATH =
  process.env.CRON_PATH ?? path.join(__dirname, "../../config/cron.json");

const TopLevelSchema = z.record(z.string(), z.unknown());

export function loadConfigField<T>(
  raw: Record<string, unknown>,
  section: string,
  schema: z.ZodTypeAny,
  field: string,
  defaultValue: T,
): T {
  if (raw[section] === undefined) return defaultValue;
  const result = schema.safeParse(raw[section]);
  if (result.success) {
    if (result.data === null || typeof result.data !== "object")
      return defaultValue;
    const value = (result.data as Record<string, unknown>)[field];
    if (value !== undefined) return value as T;
  } else {
    console.warn(
      `[${section}] 設定が不正、デフォルト使用:`,
      result.error.message,
    );
  }
  return defaultValue;
}

let _raw: Record<string, unknown> | null = null;

// config/config.json（defaultModel・poller）を読み込む
export async function loadRawConfig(): Promise<Record<string, unknown>> {
  if (_raw !== null) return _raw;
  try {
    const text = await readFile(CONFIG_PATH, "utf-8");
    _raw = TopLevelSchema.parse(JSON.parse(text));
    return _raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "config/config.json が見つかりません。config/config.example.json をコピーして作成してください",
      );
    }
    throw err;
  }
}

async function readJsonArrayFile(
  filePath: string,
  missingFileHint: string,
): Promise<unknown> {
  try {
    const text = await readFile(filePath, "utf-8");
    return JSON.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(missingFileHint);
    }
    throw err;
  }
}

// config/groups.json を読み込む
export async function loadRawGroups(): Promise<unknown> {
  return readJsonArrayFile(
    GROUPS_PATH,
    "config/groups.json が見つかりません。config/groups.example.json をコピーして作成してください",
  );
}

// config/credentials.json を読み込む
export async function loadRawCredentials(): Promise<unknown> {
  return readJsonArrayFile(
    CREDENTIALS_PATH,
    "config/credentials.json が見つかりません。config/credentials.example.json をコピーして作成してください",
  );
}

// config/cron.json を読み込む（cron は省略可能なため、ENOENT は呼び出し側で処理する）
export async function loadRawCron(): Promise<unknown> {
  const text = await readFile(CRON_PATH, "utf-8");
  return JSON.parse(text);
}
