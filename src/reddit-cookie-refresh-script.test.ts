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
      contentType?: string;
      body: string;
    }> = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          body,
        });
        response.writeHead(200);
        response.end();
      });
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
        },
      });
      expect(requests).toEqual([
        {
          method: "POST",
          url: "/maintenance/reddit-cookie-refresh",
          authorization: undefined,
          contentType: "application/json",
          body: "{}",
        },
      ]);
      expect(stdout).toContain("クッキーを更新しました");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a failed endpoint response and exits unsuccessfully", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("maintenance failed");
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
        },
      }).then(
        () => undefined,
        (error: { code?: number; stderr?: string }) => error,
      );
      expect(result).toMatchObject({
        code: 1,
        stderr: expect.stringContaining("maintenance failed"),
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
