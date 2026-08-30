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
export const PROVIDERS_PATH =
  process.env.PROVIDERS_PATH ??
  path.join(__dirname, "../../config/providers.json");
export const CRON_PATH =
  process.env.CRON_PATH ?? path.join(__dirname, "../../config/cron.json");

const TopLevelSchema = z.record(z.string(), z.unknown());

export const DiscordConfigSchema = z.object({
  bots: z
    .record(z.string().min(1), z.object({ tokenEnv: z.string().min(1) }))
    .default({}),
});
export type DiscordConfig = z.infer<typeof DiscordConfigSchema>;

export function loadConfigField<T>(
  raw: Record<string, unknown>,
  section: string,
  schema: z.ZodTypeAny,
  field: string,
  defaultValue: NoInfer<T>,
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

export async function loadDiscordConfig(): Promise<DiscordConfig> {
  const raw = await loadRawConfig();
  const config = DiscordConfigSchema.parse(raw.discord ?? {});
  if (!process.env.DISCORD_BOT_TOKEN)
    throw new Error("DISCORD_BOT_TOKEN が設定されていません");
  for (const [botId, bot] of Object.entries(config.bots)) {
    if (!process.env[bot.tokenEnv]) {
      throw new Error(
        `Discord Bot "${botId}" の環境変数 ${bot.tokenEnv} が設定されていません`,
      );
    }
  }
  return config;
}

async function readRawConfigFromDisk(): Promise<Record<string, unknown>> {
  try {
    const text = await readFile(CONFIG_PATH, "utf-8");
    return TopLevelSchema.parse(JSON.parse(text));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "config/config.json が見つかりません。config/config.example.json をコピーして作成してください",
      );
    }
    throw err;
  }
}

// config/config.json（defaultModel・proxy・agent）を読み込む
export async function loadRawConfig(): Promise<Record<string, unknown>> {
  if (_raw !== null) return _raw;
  _raw = await readRawConfigFromDisk();
  return _raw;
}

/** Read config.json without changing the process-wide startup config cache. */
export async function loadRawConfigFresh(): Promise<Record<string, unknown>> {
  return readRawConfigFromDisk();
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

// config/providers.json を読み込む（省略時は安全なデフォルト設定を使うため空配列）
export async function loadRawProviders(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(PROVIDERS_PATH, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

// config/cron.json を読み込む（cron は省略可能なため、ENOENT は呼び出し側で処理する）
export async function loadRawCron(): Promise<unknown> {
  const text = await readFile(CRON_PATH, "utf-8");
  return JSON.parse(text);
}
