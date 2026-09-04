import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as http from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("reddit:refresh command", () => {
  it("is wired to the host maintenance client", async () => {
    const packageJson = await readJson("package.json");
    const scripts = packageJson.scripts as Record<string, string>;
    const source = await readFile("scripts/reddit-cookie-refresh.ts", "utf8");

    expect(scripts["reddit:refresh"]).toBe(
      "tsx scripts/reddit-cookie-refresh.ts",
    );
    expect(source).toContain(
      'from "../src/runtime/reddit-cookie-refresh-client.js"',
    );
    expect(source).toContain("await refreshRedditCookiesInRuntime()");
  });

  it("fails clearly when the refresh authority is unavailable", async () => {
    await expect(
      execFileAsync("pnpm", ["reddit:refresh"], {
        cwd: process.cwd(),
        env: { ...process.env, AGENT_REACH_REFRESH_TOKEN: undefined },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "Agent Reach Tool Runtime refresh token is unavailable",
      ),
    });
  });

  it("redacts the refresh token from a failed endpoint response", async () => {
    const token = "refresh-token-that-must-not-be-logged";
    const server = http.createServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end(`request failed: ${token}`);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("server did not start");
      const result = await execFileAsync("pnpm", ["reddit:refresh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENT_REACH_RUNTIME_URL: `http://127.0.0.1:${address.port}`,
          AGENT_REACH_REFRESH_TOKEN: token,
        },
      }).then(
        () => undefined,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect(result).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("request failed: [redacted]"),
      });
      expect(result?.stderr).not.toContain(token);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
