import { z } from "zod";
import { refreshXCookies } from "../../proxy/x-cookie-refresh.js";
import type { CronContext } from "../runner.js";

const SettingsSchema = z
  .object({
    profileDir: z.string().optional(),
    cookieFile: z.string().optional(),
  })
  .optional();

export default async function handler(ctx: CronContext): Promise<void> {
  try {
    const settings = SettingsSchema.parse(ctx.settings);
    await refreshXCookies(settings ?? {});
    console.log("[x-cookie-refresh] x.com クッキー/CSRF token を更新しました");
  } catch (err) {
    console.error(
      `[x-cookie-refresh] 更新に失敗しました: ${err instanceof Error ? err.message : err}`,
    );
  }
}
