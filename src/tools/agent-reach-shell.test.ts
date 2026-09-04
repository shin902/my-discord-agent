import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(
  new URL(
    "../../templates/SKILLS/agent-reach/scripts/agent-reach.sh",
    import.meta.url,
  ),
);
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
          // Deliberately malformed: this frontend must not inspect or require
          // the sandbox's legacy credential-proxy configuration.
          CREDENTIAL_PROXY_JSON: "not-json",
          AGENT_REACH_TOOL_PROXY_URL: `http://127.0.0.1:${address.port}/__tool-proxy/rpc`,
          AGENT_REACH_TOOL_PROXY_TOKEN: "agent-reach-only-token",
        },
      },
    );

    expect(stdout).toBe(listingMarkdown);
    // Authorization scope is established by manager tests that create a
    // run-scoped token with ["agent-reach"], not by this fixture server.
    expect(authorization).toBe("Bearer agent-reach-only-token");
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
            AGENT_REACH_TOOL_PROXY_URL: `http://127.0.0.1:${address.port}/__tool-proxy/rpc`,
            AGENT_REACH_TOOL_PROXY_TOKEN: "run-scoped-agent-reach-token",
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
          AGENT_REACH_TOOL_PROXY_URL: `http://127.0.0.1:${address.port}/__tool-proxy/rpc`,
          AGENT_REACH_TOOL_PROXY_TOKEN: "narrow-token",
        },
      },
    );
    expect(stdout).toBe("ok");
    expect(authorization).toBe("Bearer narrow-token");
  });
});
