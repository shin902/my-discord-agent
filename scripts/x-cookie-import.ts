import { readFile } from "node:fs/promises";
import { stdin as input } from "node:process";
import { saveXCookieHeader } from "../src/proxy/x-cookie-import.js";

function usage(): string {
  return `Usage:
  pbpaste | pnpm x:cookie:import
  pnpm x:cookie:import --from-file /path/to/cookie-header.txt
  pnpm x:cookie:import --cookie-file data/x-cookies.json < cookie-header.txt

Reads an X Cookie request header and writes data/x-cookies.json (0600).
The cookie value is never printed.

Options:
  -f, --from-file <path>    Read Cookie header from file instead of stdin
  -o, --cookie-file <path>  Output cookie JSON path (default: data/x-cookies.json)
  -h, --help               Show this help
`;
}

function readOption(args: string[], longName: string, shortName: string): string | undefined {
  const longPrefix = `${longName}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === longName || arg === shortName) {
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return;
  }

  const fromFile = readOption(args, "--from-file", "-f");
  const cookieFile = readOption(args, "--cookie-file", "-o");

  if (input.isTTY && !fromFile) {
    process.stderr.write(
      "Paste an X Cookie request header, then press Ctrl-D. The value will not be printed back.\n",
    );
  }

  const rawCookieHeader = fromFile
    ? await readFile(fromFile, "utf-8")
    : await readStdin();

  const result = await saveXCookieHeader(rawCookieHeader, { cookieFile });
  process.stdout.write(`X cookie file saved: ${result.cookieFile}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
