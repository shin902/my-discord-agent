import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { build } from "esbuild";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sandboxNetworkArgs } from "../agent/sandbox-network.js";
import {
  createToolProxyRun,
  initToolProxyServer,
  stopToolProxyServer,
} from "../proxy/tool-proxy-server.js";
import { runCapabilityNames } from "../tools/skill-capabilities.js";
import * as runtime from "./tool-runtime-client.js";
import { createToolRuntimeFixture } from "./tool-runtime-fixture.js";

const execFileAsync = promisify(execFile);
const runtimeImage = process.env.TOOL_RUNTIME_TEST_IMAGE;
const agentImage =
  process.env.SANDBOX_NETWORK_TEST_IMAGE ??
  process.env.TOOL_RUNTIME_AGENT_TEST_IMAGE;
const actualExecute = runtime.executeToolRuntime;

describe.skipIf(!runtimeImage || !agentImage)(
  "Agent sandbox → Tool Proxy → disposable Runtime",
  () => {
    let fixture: Awaited<ReturnType<typeof createToolRuntimeFixture>>;
    let port: number;
    let workspace: string;
    let mountDirectory: string;
    const closers: (() => Promise<void>)[] = [];
    beforeAll(async () => {
      fixture = await createToolRuntimeFixture(runtimeImage as string);
      port = await initToolProxyServer();
      // Inject only trusted image/state locations. The actual launcher, Docker,
      // Proxy authentication, Runtime dispatch and Agent frontend all execute.
      vi.spyOn(runtime, "executeToolRuntime").mockImplementation(
        (name, args, signal) =>
          actualExecute(name, args, signal, fixture.options),
      );
      workspace = join(fixture.options.root, "workspace");
      mountDirectory = join(fixture.options.root, "agent");
      await mkdir(workspace);
      await mkdir(mountDirectory);
      for (const skill of [
        "agent-reach",
        "arxiv-search",
        "arxiv-survey",
        "last30days",
      ])
        await cp(
          `templates/SKILLS/${skill}`,
          join(workspace, "SKILLS", skill),
          { recursive: true },
        );
      await build({
        entryPoints: [
          fileURLToPath(new URL("./fixtures/agent-tools.ts", import.meta.url)),
        ],
        outfile: join(mountDirectory, "agent.mjs"),
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        external: ["better-sqlite3"],
        banner: {
          js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
        },
      });
    }, 120_000);
    afterEach(async () => {
      await Promise.all(closers.splice(0).map((close) => close()));
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      await stopToolProxyServer();
      await fixture?.dispose();
    }, 30_000);

    function startAgent() {
      const name = `issue402-agent-${randomUUID()}`;
      const config = {
        tools: [
          "agent-reach",
          "arxiv-search",
          "arxiv-survey",
          "bash",
          "read",
          "grep",
        ],
        skills: ["last30days", "arxiv-search", "arxiv-survey"],
      };
      const run = createToolProxyRun(name, runCapabilityNames(config));
      if (!run) throw new Error("Tool Proxy not initialized");
      const args = [
        "run",
        "--rm",
        "-i",
        "--name",
        name,
        ...sandboxNetworkArgs([port]),
        "--mount",
        `type=bind,src=${mountDirectory},dst=/fixture,readonly`,
        "--mount",
        `type=bind,src=${workspace},dst=/workspace`,
        "-e",
        `TOOL_PROXY_URL=${run.url}`,
        "-e",
        `TOOL_PROXY_TOKEN=${run.token}`,
        agentImage as string,
        "/app/sandbox-entrypoint.sh",
        "node",
        "/fixture/agent.mjs",
      ];
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const lines = createInterface({ input: child.stdout })[
        Symbol.asyncIterator
      ]();
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve()
            : reject(new Error(`Fixture Agent exited ${code}: ${stderr}`)),
        );
      });
      // Always observe failure immediately, including a launch failure before call().
      void done.catch(() => {});
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        child.stdin.end();
        try {
          await done;
        } finally {
          run.revoke();
          await execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
        }
      };
      closers.push(close);
      return {
        close,
        call: async (
          tool: string,
          args: unknown,
        ): Promise<AgentToolResult<unknown>> => {
          const response = lines.next();
          child.stdin.write(`${JSON.stringify({ tool, args })}\n`);
          const line = await response;
          if (line.done) {
            await done;
            throw new Error("Agent produced no response");
          }
          const payload = JSON.parse(line.value) as {
            result: AgentToolResult<unknown>;
            error?: string;
          };
          if (payload.error) throw new Error(payload.error);
          return payload.result;
        },
      };
    }
    function text(result: AgentToolResult<unknown>): string {
      return result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
    }

    it("keeps large native/Skill output through later calls, then expires only run-local files", async () => {
      const agent = startAgent();
      const result = await agent.call("agent-reach", {
        url: "https://example.com/large",
      });
      const path = (result.details as { fullOutputPath: string })
        .fullOutputPath;
      expect(path).toMatch(/^\/tmp\/my-discord-agent-tool-/);
      expect(text(result)).toContain("現在のコンテナ実行中");
      expect(text(await agent.call("read", { path, lineCount: 2 }))).toBe(
        "artifact-line\nartifact-line",
      );
      expect(
        text(
          await agent.call("grep", {
            path,
            pattern: "artifact-line",
            maxResults: 2,
          }),
        ),
      ).toContain("artifact-line");
      await agent.call("agent-reach", { url: "https://example.com/next" });
      expect(text(await agent.call("read", { path, tailCount: 1 }))).toBe(
        "artifact-line",
      );
      await agent.call("bash", {
        command:
          "bash SKILLS/agent-reach/scripts/agent-reach.sh https://example.com/large > skill.md",
      });
      expect(await readFile(join(workspace, "skill.md"), "utf8")).toBe(
        "artifact-line\n".repeat(20_000),
      );
      await agent.call("bash", { command: `cp '${path}' /workspace/saved.md` });
      await agent.close();
      const nextRun = startAgent();
      await expect(
        nextRun.call("read", { path, lineCount: 1 }),
      ).rejects.toThrow("ENOENT");
      expect(
        text(
          await nextRun.call("read", {
            path: "/workspace/saved.md",
            lineCount: 1,
          }),
        ),
      ).toBe("artifact-line");
      expect(
        text(
          await nextRun.call("read", {
            path: "/workspace/skill.md",
            lineCount: 1,
          }),
        ),
      ).toBe("artifact-line");
    }, 30_000);

    it("runs native arXiv and each Skill frontend with the same authority", async () => {
      const agent = startAgent();
      const native = text(
        await agent.call("arxiv-search", { query: "runtime" }),
      );
      const skill = text(
        await agent.call("bash", {
          command: "python3 SKILLS/arxiv-search/scripts/search.py runtime",
        }),
      );
      expect(JSON.parse(skill)).toEqual(JSON.parse(native));
      const survey = text(
        await agent.call("bash", {
          command:
            "python3 SKILLS/arxiv-survey/scripts/survey.py runtime boundary --limit 5",
        }),
      );
      expect(Array.isArray(JSON.parse(survey))).toBe(true);
      for (const [script, expected] of [
        ["hn-search", "Runtime HN fixture"],
        ["github-search", "Runtime issue fixture"],
        ["reddit-search", "Runtime Reddit fixture"],
      ]) {
        const result = await agent.call("bash", {
          command: `bash SKILLS/last30days/scripts/${script}.sh runtime`,
        });
        expect(text(result)).toContain(expected);
      }
      await expect(
        agent.call("bash", { command: "tool-proxy list-emails '{}'" }),
      ).rejects.toThrow("not authorized");
    }, 30_000);

    it("keeps direct egress closed while actual Runtime calls succeed", async () => {
      let reached = false;
      const denied = createServer((_req, res) => {
        reached = true;
        res.end("forbidden");
      });
      await new Promise<void>((resolve) =>
        denied.listen(0, "0.0.0.0", resolve),
      );
      try {
        const address = denied.address();
        if (!address || typeof address === "string") throw new Error("no port");
        const agent = startAgent();
        const result = await agent.call("bash", {
          command: `node -e "fetch('http://host.docker.internal:${address.port}', {signal: AbortSignal.timeout(1000)}).then(() => process.exit(1)).catch(() => { console.log('blocked'); process.exit(0); })"`,
        });
        expect(text(result)).toBe("blocked");
        expect(reached).toBe(false);
        expect(
          text(
            await agent.call("agent-reach", {
              url: "https://example.com/next",
            }),
          ),
        ).toBe("# Runtime web fixture");
      } finally {
        await new Promise<void>((resolve) => denied.close(() => resolve()));
      }
    }, 30_000);
  },
);
