import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createToolProxyRun,
  initToolProxyServer,
} from "../proxy/tool-proxy-server.js";
import { arxivSearchTool, arxivSurveyTool } from "./arxiv.js";

const exec = promisify(execFile);
beforeAll(async () => {
  await initToolProxyServer();
});
afterEach(() => vi.restoreAllMocks());

describe("arXiv Skill uses existing run capability authority", () => {
  it.each([
    {
      name: "arxiv-search",
      script: "search.py",
      tool: arxivSearchTool,
      input: ["decoding"],
      expected: { query: "decoding" },
    },
    {
      name: "arxiv-survey",
      script: "survey.py",
      tool: arxivSurveyTool,
      input: ["decoding", "inference"],
      expected: { queries: ["decoding", "inference"] },
    },
  ])("$name preserves JSON output and cannot use another or expired authority", async ({
    name,
    script,
    tool,
    input,
    expected,
  }) => {
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({
      content: [{ type: "text", text: '[{"id":"fixture"}]' }],
      details: {},
    });
    const run = createToolProxyRun("arxiv-skill-test", [name]);
    const denied = createToolProxyRun("arxiv-skill-denied", ["agent-reach"]);
    if (!run || !denied) throw new Error("Missing test authority");
    const args = [
      `templates/SKILLS/${name}/scripts/${script}`,
      ...input,
      "--from",
      "2026-08-01",
      "--limit",
      "5",
      "--sort",
      "updated",
    ];
    const env = {
      ...process.env,
      ARXIV_TOOL_PROXY_URL: run.url.replace(
        "host.docker.internal",
        "127.0.0.1",
      ),
      ARXIV_TOOL_PROXY_TOKEN: run.token,
    };
    try {
      const result = await exec("python3", args, { env });
      expect(JSON.parse(result.stdout)).toEqual([{ id: "fixture" }]);
      expect(execute.mock.calls[0]?.[1]).toEqual({
        ...expected,
        from: "2026-08-01",
        max_results: 5,
        sort: "updated",
      });
      await expect(
        exec("python3", args, {
          env: { ...env, ARXIV_TOOL_PROXY_TOKEN: denied.token },
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining("HTTP 403") });
      run.revoke();
      await expect(exec("python3", args, { env })).rejects.toMatchObject({
        stderr: expect.stringContaining("HTTP 401"),
      });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      run.revoke();
      denied.revoke();
    }
  });
});
