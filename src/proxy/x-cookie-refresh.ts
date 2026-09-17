import { type ChildProcess, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { visitAuthenticatedXHome } from "./x-cookie-home.js";
import {
  readXCookies,
  writeXCookiesAtomic,
  type XCookies,
} from "./x-cookie-store.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function startXvfb(display: string): ChildProcess {
  const process = spawn(
    "Xvfb",
    [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
    { stdio: "ignore" },
  );
  process.on("error", (error) =>
    console.error(`[x-cookie-refresh] Xvfb failed: ${error.message}`),
  );
  return process;
}

async function waitForXvfb(process: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const error = (cause: Error) => reject(cause);
    const exit = (code: number | null) =>
      reject(new Error(`Xvfb exited during startup (${code})`));
    process.once("error", error);
    process.once("exit", exit);
    setTimeout(() => {
      process.off("error", error);
      process.off("exit", exit);
      resolve();
    }, 500);
  });
}

async function stopXvfb(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      resolve();
    }, 2_000);
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    process.kill("SIGTERM");
  });
}

export async function refreshXCookies(
  options = {
    profileDir: resolve(ROOT, "data/x-browser-profile"),
    cookieFile: resolve(ROOT, "data/twitter-cookies.json"),
  },
): Promise<void> {
  const display = `:${190 + (process.pid % 100)}`;
  const xvfb = startXvfb(display);
  try {
    await waitForXvfb(xvfb);
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: false,
      env: { ...process.env, DISPLAY: display },
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
    });
    let cookies: XCookies;
    try {
      const page = await context.newPage();
      await visitAuthenticatedXHome(page);
      cookies = await readXCookies(context);
    } finally {
      await context.close();
    }
    await writeXCookiesAtomic(options.cookieFile, cookies);
  } catch {
    // Browser errors can contain private URLs or state; do not forward diagnostics.
    throw new Error(
      "X cookie refresh failed; check host browser setup or run pnpm x:login",
    );
  } finally {
    await stopXvfb(xvfb);
  }
}
