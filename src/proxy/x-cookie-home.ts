import type { Page } from "playwright";

export const X_HOME_URL = /^https:\/\/x\.com\/home(?:[/?#]|$)/;

/** A cookie pair alone is not proof of a live, authenticated session. */
export async function visitAuthenticatedXHome(page: Page): Promise<void> {
  const response = await page.goto("https://x.com/home", {
    waitUntil: "load",
    timeout: 30_000,
  });
  if (!response?.ok() || !X_HOME_URL.test(page.url()))
    throw new Error("X Home navigation failed; run pnpm x:login if expired");
  // SideNav renders this only with currentUser; independent of account language.
  await page.getByTestId("SideNav_AccountSwitcher_Button").waitFor({
    state: "visible",
    timeout: 30_000,
  });
  if (!X_HOME_URL.test(page.url()))
    throw new Error("X left Home before authentication was confirmed");
}
