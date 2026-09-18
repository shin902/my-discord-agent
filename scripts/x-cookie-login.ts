import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  visitAuthenticatedXHome,
  X_HOME_URL,
} from "../src/proxy/x-cookie-home.js";
import {
  readXCookies,
  writeXCookiesAtomic,
} from "../src/proxy/x-cookie-store.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = path.join(ROOT, "data/x-browser-profile");
const COOKIE_FILE = path.join(ROOT, "data/twitter-cookies.json");

export async function main(): Promise<void> {
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(
    "Sign in to x.com manually; wait for 'X cookies saved' before closing the browser.",
  );
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
  });
  const closed = new Promise<void>((resolve) => context.once("close", resolve));
  try {
    const page = await context.newPage();
    await page.goto("https://x.com/i/flow/login");
    await page.waitForURL(X_HOME_URL, { timeout: 0 });
    await visitAuthenticatedXHome(page);
    await writeXCookiesAtomic(COOKIE_FILE, await readXCookies(context));
    console.log("X cookies saved. You may close the browser.");
    await closed;
    console.log("Setup complete. Run pnpm x:refresh to verify maintenance.");
  } finally {
    await context.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  void main().catch(() => {
    console.error("X login failed; check host browser setup and sign in again");
    process.exitCode = 1;
  });
