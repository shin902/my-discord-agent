import { z } from "zod";
import {
  DEFAULT_X_COOKIE_MAX_AGE_DAYS,
  readXCookieStore,
  XCookieInvalidError,
  XCookieMissingError,
  XCookieStaleError,
} from "../../proxy/x-cookie-store.js";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";

const SettingsSchema = z.object({
  cookieFile: z.string().optional(),
  maxAgeDays: z.number().positive().default(DEFAULT_X_COOKIE_MAX_AGE_DAYS),
  nowMs: z.number().optional(),
});

export default async function handler(ctx: CronContext): Promise<void> {
  const parsed = SettingsSchema.safeParse(ctx.settings ?? {});
  if (!parsed.success) {
    throw new NonRetryableError(
      `[x-cookie-check] settings が不正です: ${parsed.error.message}`,
    );
  }
  const settings = parsed.data;

  try {
    const stored = await readXCookieStore({
      cookieFile: settings.cookieFile,
      maxAgeDays: settings.maxAgeDays,
      nowMs: settings.nowMs,
    });
    const nowMs = settings.nowMs ?? Date.now();
    const ageDays =
      (nowMs - new Date(stored.updatedAt).getTime()) / (24 * 60 * 60 * 1000);
    const remainingDays = settings.maxAgeDays - ageDays;
    console.log(
      `[x-cookie-check] x.com session cookie は有効です（残り約${remainingDays.toFixed(1)}日）`,
    );
  } catch (err) {
    if (
      err instanceof XCookieMissingError ||
      err instanceof XCookieInvalidError ||
      err instanceof XCookieStaleError
    ) {
      console.error(
        `[x-cookie-check] x.com session cookie が失効しています: ${err.message}`,
      );
      return;
    }
    throw err;
  }
}
