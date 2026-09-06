import { execFile } from "node:child_process";
import * as http from "node:http";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("reddit:refresh command", () => {
  it("refreshes through the private maintenance endpoint and reports success", async () => {
    const requests: Array<{
      method?: string;
      url?: string;
      authorization?: string;
    }> = [];
    const server = http.createServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
      response.writeHead(200);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("server did not start");
      const { stdout } = await execFileAsync("pnpm", ["reddit:refresh"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENT_REACH_RUNTIME_URL: `http://127.0.0.1:${address.port}`,
          AGENT_REACH_REFRESH_TOKEN: "test-refresh-authority",
        },
      });
      expect(requests).toEqual([
        {
          method: "POST",
          url: "/maintenance/reddit-cookie-refresh",
          authorization: "Bearer test-refresh-authority",
        },
      ]);
      expect(stdout).toContain("クッキーを更新しました");
      expect(stdout).not.toContain("test-refresh-authority");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
