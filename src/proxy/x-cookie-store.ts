import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright";

export type XCookies = { auth_token: string; ct0: string };

export async function readXCookies(context: BrowserContext): Promise<XCookies> {
  const cookies = await context.cookies("https://x.com");
  const values = new Map(cookies.map(({ name, value }) => [name, value]));
  const auth_token = values.get("auth_token");
  const ct0 = values.get("ct0");
  if (!auth_token || !ct0)
    throw new Error("X session is missing auth_token or ct0; log in again");
  return { auth_token, ct0 };
}

/** Replace the two-value credential file without exposing a partial write. */
export async function writeXCookiesAtomic(
  cookieFile: string,
  cookies: XCookies,
): Promise<void> {
  await mkdir(path.dirname(cookieFile), { recursive: true });
  const temporary = `${cookieFile}.${process.pid}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(cookies, null, 2)}\n`);
    await file.sync();
    await file.close();
    await rename(temporary, cookieFile);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}
