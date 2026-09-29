import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

const DEFAULT_PROFILE_DIR = path.join(ROOT, "data/reddit-browser-profile");
const DEFAULT_COOKIE_FILE = path.join(ROOT, "data/reddit-cookies.json");
const NAV_TIMEOUT_MS = 30_000;

// ヘッドレス Chromium (chrome-headless-shell) は Reddit の bot 対策に検知され
// ブロックされるが、Xvfb 上でフルChromiumを headless:false 起動すると通過する
// ことを実機検証で確認済み(docs/guides/reddit-cookie-setup.md 参照)。
function startXvfb(display: string): ChildProcess {
  const proc = spawn(
    "Xvfb",
    [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
    { stdio: "ignore" },
  );
  // spawn失敗時(Xvfb未インストール等)はデフォルトでエラーが握り潰されるため明示的にログ出力する
  proc.on("error", () => {
    console.error("[reddit-cookie-refresh] Xvfb起動失敗");
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

export async function readAuthenticatedRedditCookies(
  context: BrowserContext,
): Promise<string> {
  const page = await context.newPage();
  const response = await page.goto("https://www.reddit.com", {
    waitUntil: "load",
    timeout: NAV_TIMEOUT_MS,
  });
  if (
    !response?.ok() ||
    new URL(page.url()).hostname !== "www.reddit.com" ||
    /\/login(?:[/?#]|$)/.test(page.url())
  )
    throw new Error("Reddit navigation failed or login expired");
  // A 200 challenge/error document is not a successful Reddit page.
  await page
    .locator("shreddit-app")
    .waitFor({ state: "attached", timeout: NAV_TIMEOUT_MS });

  const me = await context.request.get("https://www.reddit.com/api/me.json", {
    timeout: NAV_TIMEOUT_MS,
  });
  if (!me.ok()) throw new Error("Reddit authentication check failed");
  const identity = await me.json().catch(() => null);
  if (
    identity?.kind !== "t2" ||
    typeof identity.data?.name !== "string" ||
    !identity.data.name
  )
    throw new Error("Reddit session is not authenticated");

  const cookies = await context.cookies("https://www.reddit.com");
  if (
    !cookies.some((cookie) => cookie.name === "reddit_session" && cookie.value)
  )
    throw new Error("Reddit session cookie is missing");
  return cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

export async function writeRedditCookiesAtomic(
  cookieFile: string,
  cookieHeader: string,
): Promise<void> {
  await mkdir(path.dirname(cookieFile), { recursive: true });
  const temporary = `${cookieFile}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(
      JSON.stringify(
        { cookieHeader, updatedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    await file.sync();
    await file.close();
    await rename(temporary, cookieFile);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function refreshRedditCookies(
  options: { profileDir?: string; cookieFile?: string } = {},
): Promise<void> {
  const profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
  const cookieFile = options.cookieFile ?? DEFAULT_COOKIE_FILE;
  const display = `:${90 + (process.pid % 100)}`;

  const xvfb = startXvfb(display);
  try {
    await waitForXvfbReady(xvfb);

    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      env: { ...process.env, DISPLAY: display },
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
    });
    let cookieHeader: string;
    try {
      cookieHeader = await readAuthenticatedRedditCookies(context);
    } finally {
      await context.close();
    }
    await writeRedditCookiesAtomic(cookieFile, cookieHeader);
  } catch {
    // Browser diagnostics can contain credentials or private URLs.
    throw new Error(
      "Reddit cookie refresh failed; check host browser setup or run pnpm reddit:login",
    );
  } finally {
    await stopXvfb(xvfb);
  }
}
