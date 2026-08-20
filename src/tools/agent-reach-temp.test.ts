import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentReachTool, type ExecuteCommand } from "./agent-reach.js";

function outputPathFromCommand(command: string): string {
  const match = /-o '([^']+)'/.exec(command);
  if (!match) throw new Error(`output path not found in command: ${command}`);
  return match[1];
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}

const resolvePublic = async () => [{ address: "8.8.8.8", family: 4 }];

describe("agent-reach temporary directories", () => {
  it("uses a call-scoped system-temp directory and removes it on success", async () => {
    let command = "";
    const execute: ExecuteCommand = async (nextCommand) => {
      command = nextCommand;
      await writeFile(outputPathFromCommand(nextCommand), "fetched content", "utf8");
      return { stdout: "200", stderr: "" };
    };
    const tool = createAgentReachTool(resolvePublic, execute);
    const result = await tool.execute("temp-success", { url: "https://example.com/article" });
    const outputPath = outputPathFromCommand(command);
    const callDir = dirname(outputPath);
    expect(result.content[0]).toEqual({ type: "text", text: "fetched content" });
    expect(callDir.startsWith(`${tmpdir()}/agent-reach-`)).toBe(true);
    expect(outputPath).not.toContain("/workspace");
    await expectMissing(callDir);
  });

  it("removes the call-scoped directory when fetching fails", async () => {
    let callDir = "";
    const execute: ExecuteCommand = async (command) => {
      callDir = dirname(outputPathFromCommand(command));
      throw new Error("network failure");
    };
    const tool = createAgentReachTool(resolvePublic, execute);
    await expect(tool.execute("temp-failure", { url: "https://example.com/article" })).rejects.toThrow("network failure");
    expect(callDir.startsWith(`${tmpdir()}/agent-reach-`)).toBe(true);
    await expectMissing(callDir);
  });

  it("gives concurrent calls isolated directories and cleans both", async () => {
    const callDirs: string[] = [];
    let release: () => void = () => undefined;
    const bothCalls = new Promise<void>((resolve) => { release = resolve; });
    const execute: ExecuteCommand = async (command) => {
      const outputPath = outputPathFromCommand(command);
      callDirs.push(dirname(outputPath));
      if (callDirs.length === 2) release();
      await bothCalls;
      await writeFile(outputPath, `content-${callDirs.length}`, "utf8");
      return { stdout: "200", stderr: "" };
    };
    const tool = createAgentReachTool(resolvePublic, execute);
    await Promise.all([
      tool.execute("temp-concurrent-1", { url: "https://example.com/one" }),
      tool.execute("temp-concurrent-2", { url: "https://example.com/two" }),
    ]);
    expect(callDirs).toHaveLength(2);
    expect(new Set(callDirs).size).toBe(2);
    for (const callDir of callDirs) {
      expect(callDir.startsWith(`${tmpdir()}/agent-reach-`)).toBe(true);
      await expectMissing(callDir);
    }
  });
});
