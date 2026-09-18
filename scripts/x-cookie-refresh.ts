import "dotenv/config";
import { fileURLToPath } from "node:url";
import { refreshXCookies } from "../src/proxy/x-cookie-refresh.js";

export async function main(): Promise<void> {
  try {
    await refreshXCookies();
    console.log("[x-cookie-refresh] X cookies refreshed");
  } catch {
    console.error(
      "[x-cookie-refresh] Refresh failed; check host browser setup or run pnpm x:login",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
