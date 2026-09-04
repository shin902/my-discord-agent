import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dnsLookupMock = vi.hoisted(() =>
  vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
);
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));

import { agentReachTool } from "./agent-reach.js";

const directories: string[] = [];
const originalEnvironment = {
  PATH: process.env.PATH,
  REDDIT_COOKIE_FILE: process.env.REDDIT_COOKIE_FILE,
  FAKE_CURL_CAPTURE: process.env.FAKE_CURL_CAPTURE,
};
const COOKIE = "reddit_session=distinctive-cookie-secret";

async function setup(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-reach-cookie-"));
  directories.push(directory);
  const cookieFile = join(directory, "reddit-cookies.json");
  const captureFile = join(directory, "captured-header");
  const curl = join(directory, "curl");
  await writeFile(
    cookieFile,
    JSON.stringify({
      cookieHeader: COOKIE,
      updatedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    curl,
    `#!/bin/sh
set -eu
header_file=""
out_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -H) header_file="$2"; shift 2 ;;
    -o) out_file="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$header_file" ]; then cat "\${header_file#@}" > "$FAKE_CURL_CAPTURE"; fi
printf '%s' '{"data":{"children":[]}}' > "$out_file"
printf '200'
`,
    { mode: 0o700 },
  );
  await chmod(curl, 0o700);
  process.env.PATH = `${directory}${delimiter}${originalEnvironment.PATH ?? ""}`;
  process.env.REDDIT_COOKIE_FILE = cookieFile;
  process.env.FAKE_CURL_CAPTURE = captureFile;
}

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("agent-reach Reddit cookie boundary", () => {
  it("passes the cookie via a protected header file and preserves successful fetch", async () => {
    await setup();

    await expect(
      agentReachTool.execute("test", { url: "https://www.reddit.com/r/test" }),
    ).resolves.toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("構造を解析できませんでした"),
        },
      ],
    });
    expect(await readFile(process.env.FAKE_CURL_CAPTURE ?? "", "utf8")).toBe(
      `Cookie: ${COOKIE}\n`,
    );
  });
});
