import { type ChildProcess, spawn } from "node:child_process";
import { chromium } from "playwright";
import { readXCookies, writeXCookiesAtomic } from "./x-cookie-store.js";

const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 4_000;

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

export async function refreshXCookies(options: {
  profileDir: string;
  cookieFile: string;
}): Promise<void> {
  const display = `:${190 + (process.pid % 100)}`;
  const xvfb = startXvfb(display);
  const previousDisplay = process.env.DISPLAY;
  process.env.DISPLAY = display;
  try {
    await waitForXvfb(xvfb);
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: false,
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
    });
    try {
      const page = await context.newPage();
      await page.goto("https://x.com/home", {
        waitUntil: "load",
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForTimeout(SETTLE_MS);
      if (/\/i\/flow\/login/.test(page.url()))
        throw new Error("X session expired; run pnpm x:login again");
      await writeXCookiesAtomic(
        options.cookieFile,
        await readXCookies(context),
      );
    } finally {
      await context.close();
    }
  } finally {
    if (previousDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = previousDisplay;
    await stopXvfb(xvfb);
  }
}
