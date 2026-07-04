import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

const DEFAULT_PROFILE_DIR = path.join(ROOT, "data/x-browser-profile");
const DEFAULT_COOKIE_FILE = path.join(ROOT, "data/x-cookies.json");
const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 5_000;

type BrowserCookie = {
  name: string;
  value: string;
  domain?: string;
};

export type StoredXCookies = {
  cookieHeader: string;
  csrfToken: string;
  updatedAt: string;
};

export type XCookieRefreshOptions = {
  profileDir?: string;
  cookieFile?: string;
};

function resolveDataPath(input: string | undefined, fallback: string): string {
  if (!input) return fallback;
  return path.isAbsolute(input) ? input : path.resolve(ROOT, input);
}

function startXvfb(display: string): ChildProcess {
  const proc = spawn(
    "Xvfb",
    [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
    { stdio: "ignore" },
  );
  proc.on("error", (err) => {
    console.error(`[x-cookie-refresh] Xvfb起動失敗: ${err.message}`);
  });
  return proc;
}

async function waitForXvfbReady(xvfb: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    const onExit = (code: number | null) =>
      reject(new Error(`Xvfbが起動直後に終了しました (exit code: ${code})`));
    xvfb.once("error", onError);
    xvfb.once("exit", onExit);
    setTimeout(() => {
      xvfb.off("error", onError);
      xvfb.off("exit", onExit);
      resolve();
    }, 500);
  });
}

async function stopXvfb(xvfb: ChildProcess): Promise<void> {
  if (xvfb.exitCode !== null || xvfb.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      xvfb.kill("SIGKILL");
      resolve();
    }, 2_000);
    xvfb.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    xvfb.kill("SIGTERM");
  });
}

export function extractXCookies(
  cookies: BrowserCookie[],
): Omit<StoredXCookies, "updatedAt"> {
  const authToken = cookies.find((c) => c.name === "auth_token")?.value;
  if (!authToken) {
    throw new Error(
      "x.com の auth_token cookie が取得できませんでした。取得専用アカウントで初回ログインしてください",
    );
  }

  const csrfToken = cookies.find((c) => c.name === "ct0")?.value;
  if (!csrfToken) {
    throw new Error(
      "x.com の ct0 cookie (CSRF token) が取得できませんでした。取得専用アカウントで再ログインしてください",
    );
  }

  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  return { cookieHeader, csrfToken };
}

export async function refreshXCookies(
  options: XCookieRefreshOptions = {},
): Promise<StoredXCookies> {
  const profileDir = resolveDataPath(options.profileDir, DEFAULT_PROFILE_DIR);
  const cookieFile = resolveDataPath(options.cookieFile, DEFAULT_COOKIE_FILE);
  const display = `:${110 + (process.pid % 100)}`;

  const xvfb = startXvfb(display);
  const prevDisplay = process.env.DISPLAY;
  process.env.DISPLAY = display;

  try {
    await waitForXvfbReady(xvfb);

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
    });
    try {
      const page = await context.newPage();
      await page.goto("https://x.com/home", {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForTimeout(SETTLE_MS);

      if (/\/i\/flow\/login|\/login/.test(page.url())) {
        throw new Error(
          "x.com のセッションが失効し、ログイン画面にリダイレクトされました。取得専用アカウントで再ログインしてください",
        );
      }

      const cookies = await context.cookies([
        "https://x.com",
        "https://twitter.com",
      ]);
      const extracted = extractXCookies(cookies);
      const stored: StoredXCookies = {
        ...extracted,
        updatedAt: new Date().toISOString(),
      };

      await mkdir(path.dirname(cookieFile), { recursive: true });
      await writeFile(cookieFile, JSON.stringify(stored, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });
      return stored;
    } finally {
      await context.close();
    }
  } finally {
    if (prevDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = prevDisplay;
    await stopXvfb(xvfb);
  }
}
