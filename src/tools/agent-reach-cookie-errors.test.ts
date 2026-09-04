import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dnsLookupMock = vi.hoisted(() =>
  vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
);
const execAsyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));
vi.mock("./exec.js", () => ({ execAsync: execAsyncMock }));

import { agentReachTool } from "./agent-reach.js";

const directories: string[] = [];
const originalCookieFile = process.env.REDDIT_COOKIE_FILE;
const COOKIE = "reddit_session=distinctive-cookie-secret";

async function setup(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-reach-cookie-errors-"));
  directories.push(directory);
  const cookieFile = join(directory, "reddit-cookies.json");
  await mkdir(directory, { recursive: true });
  await writeFile(
    cookieFile,
    JSON.stringify({
      cookieHeader: COOKIE,
      updatedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  process.env.REDDIT_COOKIE_FILE = cookieFile;
  execAsyncMock.mockReset();
}

async function execute(): Promise<unknown> {
  return agentReachTool.execute("test", {
    url: "https://www.reddit.com/r/test",
  });
}

function expectSafeError(error: unknown): void {
  expect(String(error)).not.toContain(COOKIE);
  expect(String(error)).not.toContain("Cookie:");
}

afterEach(async () => {
  if (originalCookieFile === undefined) delete process.env.REDDIT_COOKIE_FILE;
  else process.env.REDDIT_COOKIE_FILE = originalCookieFile;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("agent-reach Reddit cookie errors", () => {
  it("malformed cookie state exposes only the fixed diagnostic", async () => {
    await setup();
    const cookiePath = process.env.REDDIT_COOKIE_FILE;
    if (!cookiePath) throw new Error("cookie path was not configured");
    const secret = "malformed-cookie-distinctive-secret";
    await writeFile(cookiePath, `{"cookieHeader":"${secret}"`, { mode: 0o600 });

    await expect(execute()).rejects.toSatisfy((error: unknown) => {
      expect(String(error)).toContain(
        "reddit cookie の状態が不正です (provider: reddit)",
      );
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(cookiePath);
      return true;
    });
    expect(execAsyncMock).not.toHaveBeenCalled();
  });

  it("subprocess failure does not expose the cookie", async () => {
    await setup();
    execAsyncMock.mockRejectedValueOnce(
      Object.assign(
        new Error("Command failed: curl -H @/tmp/reddit-cookie.header"),
        {
          stderr: `upstream failed: ${COOKIE}`,
        },
      ),
    );

    await expect(execute()).rejects.toSatisfy((error: unknown) => {
      expectSafeError(error);
      return true;
    });
    expect(execAsyncMock).toHaveBeenCalledOnce();
    expect(execAsyncMock.mock.calls[0]?.[0]).not.toContain(COOKIE);
  });

  it("timeout does not expose the cookie", async () => {
    await setup();
    execAsyncMock.mockRejectedValueOnce(
      Object.assign(
        new Error("Command timed out: curl -H @/tmp/reddit-cookie.header"),
        {
          stderr: COOKIE,
        },
      ),
    );

    await expect(execute()).rejects.toSatisfy((error: unknown) => {
      expectSafeError(error);
      return true;
    });
  });

  it("abort does not expose the cookie", async () => {
    await setup();
    execAsyncMock.mockImplementationOnce(
      async (_command: string, options: { signal?: AbortSignal }) => {
        await new Promise<void>((_resolve, reject) => {
          const rejectAborted = () =>
            reject(
              Object.assign(new Error("The operation was aborted"), {
                stderr: COOKIE,
              }),
            );
          if (options.signal?.aborted) rejectAborted();
          else
            options.signal?.addEventListener("abort", rejectAborted, {
              once: true,
            });
        });
      },
    );
    const controller = new AbortController();
    const promise = agentReachTool.execute(
      "test",
      { url: "https://www.reddit.com/r/test" },
      controller.signal,
    );
    controller.abort();

    await expect(promise).rejects.toSatisfy((error: unknown) => {
      expectSafeError(error);
      return true;
    });
  });
});
