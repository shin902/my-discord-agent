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
