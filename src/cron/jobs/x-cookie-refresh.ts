import { refreshXCookies } from "../../proxy/x-cookie-refresh.js";
import type { CronContext } from "../runner.js";

export default async function handler(_context: CronContext): Promise<void> {
  try {
    await refreshXCookies();
    console.log("[x-cookie-refresh] X cookies refreshed");
  } catch (error) {
    console.error(
      "[x-cookie-refresh] Refresh failed; check host browser setup or run pnpm x:login",
    );
    throw error;
  }
}
