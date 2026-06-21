import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

const DEFAULT_PROFILE_DIR = path.join(ROOT, "data/reddit-browser-profile");
const DEFAULT_COOKIE_FILE = path.join(ROOT, "data/reddit-cookies.json");
const NAV_TIMEOUT_MS = 30_000;
const SETTLE_MS = 4_000;

// ヘッドレス Chromium (chrome-headless-shell) は Reddit の bot 対策に検知され
// ブロックされるが、Xvfb 上でフルChromiumを headless:false 起動すると通過する
// ことを実機検証で確認済み(docs/reddit-cookie-setup.md 参照)。
function startXvfb(display: string): ChildProcess {
  const proc = spawn(
    "Xvfb",
    [display, "-screen", "0", "1280x1024x24", "-nolisten", "tcp"],
    { stdio: "ignore" },
  );
  // spawn失敗時(Xvfb未インストール等)はデフォルトでエラーが握り潰されるため明示的にログ出力する
  proc.on("error", (err) => {
    console.error(`[reddit-cookie-refresh] Xvfb起動失敗: ${err.message}`);
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

export async function refreshRedditCookies(
  options: { profileDir?: string; cookieFile?: string } = {},
): Promise<void> {
  const profileDir = options.profileDir ?? DEFAULT_PROFILE_DIR;
  const cookieFile = options.cookieFile ?? DEFAULT_COOKIE_FILE;
  const display = `:${90 + (process.pid % 100)}`;

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
      await page.goto("https://www.reddit.com", {
        waitUntil: "load",
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForTimeout(SETTLE_MS);

      const cookies = await context.cookies("https://www.reddit.com");
      if (cookies.length === 0) {
        throw new Error(
          "reddit.com のクッキーが取得できませんでした。scripts/reddit-cookie-login.ts で初回ログインを行ってください",
        );
      }

      const cookieHeader = cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");

      await mkdir(path.dirname(cookieFile), { recursive: true });
      await writeFile(
        cookieFile,
        JSON.stringify(
          { cookieHeader, updatedAt: new Date().toISOString() },
          null,
          2,
        ),
        { encoding: "utf-8", mode: 0o600 },
      );
    } finally {
      await context.close();
    }
  } finally {
    if (prevDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = prevDisplay;
    await stopXvfb(xvfb);
  }
}
