import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(
  new URL(
    "../../templates/SKILLS/agent-reach/scripts/agent-reach.sh",
    import.meta.url,
  ),
);
let cliDirectory: string;
let cliPath: string;
beforeAll(async () => {
  cliDirectory = await mkdtemp(join(tmpdir(), "tool-proxy-cli-test-"));
  await writeFile(
    join(cliDirectory, "tool-proxy"),
    `#!/bin/sh\nexec node --import tsx "${process.cwd()}/src/sandbox/tool-proxy-cli.ts" "$@"\n`,
    { mode: 0o700 },
  );
  cliPath = `${cliDirectory}:${process.env.PATH}`;
});
afterAll(async () => {
  await rm(cliDirectory, { recursive: true, force: true });
});

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("agent-reach.sh Tool Proxy frontend", () => {
  it("last30days Reddit search calls the agent-reach frontend without credential proxy parsing", async () => {
    const last30daysScript = fileURLToPath(
      new URL(
        "../../templates/SKILLS/last30days/scripts/reddit-search.sh",
        import.meta.url,
      ),
    );
    let requestBody: Record<string, unknown> | undefined;
    let authorization = "";
    const listingMarkdown = [
      "# 投稿一覧",
      "",
      "## result",
      "r/typescript | u/user | スコア: 42 | コメント: 7",
      "スレッド: https://reddit.com/r/typescript/comments/abc123/result/",
      "外部URL: https://example.com/article",
    ].join("\n");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requestBody = JSON.parse(body) as Record<string, unknown>;
        authorization = String(req.headers.authorization);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            result: {
              content: [{ type: "text", text: listingMarkdown }],
            },
          }),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server did not listen");

    const { stdout } = await execFileAsync(
      "bash",
      [last30daysScript, "tool runtime"],
      {
        env: {
          ...process.env,
          PATH: cliPath,
          DOTENV_CONFIG_PATH: "/dev/null",
          // Deliberately malformed: this frontend must not inspect or require
          // the sandbox's legacy credential-proxy configuration.
          CREDENTIAL_PROXY_JSON: "not-json",
          TOOL_PROXY_URL: `http://127.0.0.1:${address.port}/__tool-proxy/rpc`,
          TOOL_PROXY_TOKEN: "shared-run-token",
        },
      },
    );

    expect(stdout).toBe(listingMarkdown);
    // Manager tests establish the shared run authority; this checks transport.
    expect(authorization).toBe("Bearer shared-run-token");
    expect(requestBody).toEqual({
      capability: "agent-reach",
      args: {
        url: "https://www.reddit.com/search.json?q=tool+runtime&sort=top&t=month&limit=10",
      },
    });
  });

  it("stdoutを維持しshell redirectionで保存できる", async () => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        expect(JSON.parse(body)).toEqual({
          capability: "agent-reach",
          args: { url: "https://example.com/post" },
        });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            result: { content: [{ type: "text", text: "# result" }] },
          }),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server did not listen");
    const dir = await mkdtemp(join(tmpdir(), "agent-reach-shell-"));
    try {
      const output = join(dir, "output.md");
      await execFileAsync(
        "bash",
        [
          "-c",
          `${script} "$1" > "$2"`,
          "shell",
          "https://example.com/post",
          output,
        ],
        {
          env: {
            ...process.env,
            PATH: cliPath,
            DOTENV_CONFIG_PATH: "/dev/null",
            TOOL_PROXY_URL: `http://127.0.0.1:${address.port}/__tool-proxy/rpc`,
            TOOL_PROXY_TOKEN: "shared-run-token",
          },
        },
      );
      await expect(readFile(output, "utf8")).resolves.toBe("# result");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("proxy以外へ接続せず、agent-reach capabilityだけを送る", async () => {
    let authorization = "";
    const server = createServer((req, res) => {
      authorization = String(req.headers.authorization);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ result: { content: [{ type: "text", text: "ok" }] } }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("server did not listen");
    const { stdout } = await execFileAsync(
      "bash",
      [script, "https://example.com"],
      {
        env: {
          ...process.env,
          PATH: cliPath,
          DOTENV_CONFIG_PATH: "/dev/null",
          TOOL_PROXY_URL: `http://127.0.0.1:${address.port}/__tool-proxy/rpc`,
          TOOL_PROXY_TOKEN: "shared-run-token",
        },
      },
    );
    expect(stdout).toBe("ok");
    expect(authorization).toBe("Bearer shared-run-token");
  });
});
