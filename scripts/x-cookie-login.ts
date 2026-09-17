import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  readXCookies,
  writeXCookiesAtomic,
} from "../src/proxy/x-cookie-store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = path.join(ROOT, "data/x-browser-profile");
const COOKIE_FILE = path.join(ROOT, "data/twitter-cookies.json");

export async function main(): Promise<void> {
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log("Sign in to x.com manually, wait for Home, then close the browser.");
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
  });
  const page = await context.newPage();
  await page.goto("https://x.com/i/flow/login");

  await page.waitForURL(/^https:\/\/(?:www\.)?x\.com\/home(?:[/?#]|$)/, {
    timeout: 0,
  });
  await writeXCookiesAtomic(COOKIE_FILE, await readXCookies(context));
  console.log("X cookies saved. You may close the browser.");
  await new Promise<void>((resolve) => context.on("close", resolve));
  console.log("Setup complete. Run pnpm x:refresh to verify maintenance.");
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : "X login failed");
    process.exitCode = 1;
  });
