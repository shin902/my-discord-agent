import { access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentReachTool } from "./agent-reach.js";
import { execAsync } from "./exec.js";

vi.mock("./exec.js", () => ({ execAsync: vi.fn() }));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));

function outputPathFromCommand(command: string): string {
  const match = /-o '([^']+)'/.exec(command);
  if (!match) throw new Error(`output path not found in command: ${command}`);
  return match[1];
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}

describe("agent-reach temporary directories", () => {
  beforeEach(() => {
    vi.mocked(execAsync).mockReset();
  });

  it("uses a call-scoped system-temp directory and removes it on success", async () => {
    let command = "";
    vi.mocked(execAsync).mockImplementation(async (nextCommand) => {
      command = nextCommand;
      await writeFile(
        outputPathFromCommand(nextCommand),
        "fetched content",
        "utf8",
      );
      return { stdout: "200", stderr: "" };
    });

    const result = await agentReachTool.execute("temp-success", {
      url: "https://example.com/article",
    });
    const outputPath = outputPathFromCommand(command);
    const callDir = dirname(outputPath);

    expect(result.content[0]).toEqual({
      type: "text",
      text: "fetched content",
    });
    expect(callDir.startsWith(`${tmpdir()}/agent-reach-`)).toBe(true);
    expect(outputPath).not.toContain("/workspace");
    await expectMissing(callDir);
  });

  it("removes the call-scoped directory when fetching fails", async () => {
    let callDir = "";
    vi.mocked(execAsync).mockImplementation(async (command) => {
      callDir = dirname(outputPathFromCommand(command));
      throw new Error("network failure");
    });

    await expect(
      agentReachTool.execute("temp-failure", {
        url: "https://example.com/article",
      }),
    ).rejects.toThrow("network failure");

    expect(callDir.startsWith(`${tmpdir()}/agent-reach-`)).toBe(true);
    await expectMissing(callDir);
  });

  it("gives concurrent calls isolated directories and cleans both", async () => {
    const callDirs: string[] = [];
    let release: () => void = () => undefined;
    const bothCalls = new Promise<void>((resolve) => {
      release = resolve;
    });

    vi.mocked(execAsync).mockImplementation(async (command) => {
      const outputPath = outputPathFromCommand(command);
      callDirs.push(dirname(outputPath));
      if (callDirs.length === 2) release();
      await bothCalls;
      await writeFile(outputPath, `content-${callDirs.length}`, "utf8");
      return { stdout: "200", stderr: "" };
    });

    await Promise.all([
      agentReachTool.execute("temp-concurrent-1", {
        url: "https://example.com/one",
      }),
      agentReachTool.execute("temp-concurrent-2", {
        url: "https://example.com/two",
      }),
    ]);

    expect(callDirs).toHaveLength(2);
    expect(new Set(callDirs).size).toBe(2);
    for (const callDir of callDirs) {
      expect(callDir.startsWith(`${tmpdir()}/agent-reach-`)).toBe(true);
      await expectMissing(callDir);
    }
  });
});
