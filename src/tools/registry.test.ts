import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

import { agentReachTool } from "./agent-reach.js";
import { arxivSearchTool, arxivSurveyTool } from "./arxiv.js";
import {
  listIssueCommentsTool,
  listPullRequestCommentsTool,
  readPullRequestTool,
} from "./github.js";
import { wrapToolOutput } from "./output.js";
import { resolveTools } from "./registry.js";

describe("resolveTools", () => {
  it("agent-reach を解決して agentReachTool を返す", () => {
    expect(resolveTools(["agent-reach"])).toEqual([agentReachTool]);
  });

  it("arxiv-search / arxiv-survey を解決する", () => {
    expect(resolveTools(["arxiv-search", "arxiv-survey"])).toEqual([
      arxivSearchTool,
      arxivSurveyTool,
    ]);
  });

  it("list-issue-comments を解決して listIssueCommentsTool を返す", () => {
    expect(resolveTools(["list-issue-comments"])).toEqual([
      listIssueCommentsTool,
    ]);
  });

  it("read-pull-request を解決して readPullRequestTool を返す", () => {
    expect(resolveTools(["read-pull-request"])).toEqual([readPullRequestTool]);
  });

  it("list-pull-request-comments を解決して listPullRequestCommentsTool を返す", () => {
    expect(resolveTools(["list-pull-request-comments"])).toEqual([
      listPullRequestCommentsTool,
    ]);
  });

  it("context-createdなbotとsubagentはregistryで検証されるが生成しない", () => {
    expect(resolveTools(["bot", "subagent"])).toEqual([]);
  });

  it("空配列は空配列を返す", () => {
    expect(resolveTools([])).toEqual([]);
  });

  it("不明なツール名はエラーをスローする", () => {
    expect(() => resolveTools(["invalid"])).toThrow("不明なツール名: invalid");
  });

  it("production registry tools receive the common output boundary", async () => {
    const directory = await mkdtemp("/tmp/registry-output-");
    const path = join(directory, "input.txt");
    const text = "registry-line\n".repeat(5_000);
    await writeFile(path, text, "utf8");

    try {
      const [tool] = resolveTools(["read"]);
      const result = await tool.execute("call-1", { path });

      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("ツール出力が大きいため"),
      });
      expect(result.details).toMatchObject({
        truncated: true,
        fullOutputPath: expect.stringMatching(/^\/tmp\/my-discord-agent-tool-/),
        truncation: {
          reason: "text-output-too-large",
          totalCharacters: text.length,
          totalBytes: Buffer.byteLength(text, "utf8"),
          totalLines: 5_000,
          inlineCharacterLimit: 50_000,
          lifetime: "container-run",
        },
      });
      const fullOutputPath = (result.details as { fullOutputPath: string })
        .fullOutputPath;
      expect(await readFile(fullOutputPath, "utf8")).toBe(text);
      await rm(dirname(fullOutputPath), { recursive: true, force: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not multi-wrap singleton tools", () => {
    const [first] = resolveTools(["read"]);
    const [second] = resolveTools(["read"]);
    const [duplicateFirst, duplicateSecond] = resolveTools(["read", "read"]);

    expect(second).toBe(first);
    expect(duplicateFirst).toBe(first);
    expect(duplicateSecond).toBe(first);
  });

  it("wrapToolOutput is idempotent for a singleton and invokes its execute once", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "small output" }],
      details: { source: "test" },
    }));
    const tool: AgentTool = {
      name: "singleton-test",
      label: "singleton-test",
      description: "singleton-test",
      parameters: {} as never,
      execute,
    };

    expect(wrapToolOutput(tool)).toBe(tool);
    expect(wrapToolOutput(tool)).toBe(tool);
    await tool.execute("call-1", {});

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
