import { importXCookiesFromBrowserDb } from "../src/proxy/x-browser-cookie-import.js";
import type { BrowserCookieSource } from "../src/proxy/x-browser-cookie-import.js";

function usage(): string {
  return `Usage:
  pnpm x:cookie:from-browser --source firefox --profile-dir ~/.mozilla/firefox/xxxx.default-release
  pnpm x:cookie:from-browser --source chromium --profile-dir ~/.config/google-chrome/Default
  pnpm x:cookie:from-browser --db ~/.mozilla/firefox/xxxx.default-release/cookies.sqlite
  pnpm x:cookie:from-browser --db ~/.config/google-chrome/Default/Network/Cookies --source chromium

Reads X-related cookies from a local browser cookie SQLite DB and writes data/x-cookies.json (0600).
Cookie values are never printed.

Options:
  --source <firefox|chromium|auto>  Browser DB type (default: auto with --db)
  --db <path>                       Path to cookie SQLite DB
  --profile-dir <path>              Browser profile dir. Firefox: cookies.sqlite, Chromium: Network/Cookies
  -o, --cookie-file <path>          Output cookie JSON path (default: data/x-cookies.json)
  -h, --help                        Show this help

Notes:
  Chromium cookies may be OS-encrypted. This script does not decrypt them; use Firefox or x:cookie:import if needed.
`;
}

function readOption(args: string[], longName: string, shortName?: string): string | undefined {
  const longPrefix = `${longName}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === longName || (shortName && arg === shortName)) {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a value.`);
      }
      return value;
    }
    if (arg.startsWith(longPrefix)) {
      const value = arg.slice(longPrefix.length);
      if (!value) throw new Error(`${longName} requires a value.`);
      return value;
    }
  }
  return undefined;
}

function parseSource(value: string | undefined): BrowserCookieSource | undefined {
  if (!value) return undefined;
  if (value === "firefox" || value === "chromium" || value === "auto") return value;
  throw new Error("--source must be firefox, chromium, or auto.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }

  const source = parseSource(readOption(args, "--source"));
  const dbPath = readOption(args, "--db");
  const profileDir = readOption(args, "--profile-dir");
  const cookieFile = readOption(args, "--cookie-file", "-o");

  const result = await importXCookiesFromBrowserDb({
    source,
    dbPath,
    profileDir,
    cookieFile,
  });

  process.stdout.write(`X cookie file saved: ${result.cookieFile}\n`);
  process.stdout.write(`Source DB: ${result.dbPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
