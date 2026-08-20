import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import { resolveModel } from "../agent/model.js";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import {
  DEFAULT_SYSTEM_PROMPT,
  defaultConvertToLlm,
  type AgentRunnerDependencies,
  runAgentLoop,
  waitForNetwork,
} from "./agent-runner.js";

type RunnerAgent = ReturnType<AgentRunnerDependencies["createAgent"]>;
type RunnerOptions = Parameters<AgentRunnerDependencies["createAgent"]>[0];

type TestAgent = {
  subscribe: RunnerAgent["subscribe"];
  prompt: RunnerAgent["prompt"];
};

function createFakeAgent(): TestAgent {
  const prompt: RunnerAgent["prompt"] = async (_input: string | AgentMessage | AgentMessage[], _images?: ImageContent[]) => undefined;
  return {
    subscribe: (_listener) => () => undefined,
    prompt,
  };
}

function dependencies(
  files: Readonly<Record<string, string>> = {},
  history: AgentMessage[] = [],
): AgentRunnerDependencies {
  const appended: AgentMessage[] = [];
  return {
    loadMessages: async () => history,
    appendMessage: async (_group, _session, message) => {
      appended.push(message);
    },
    readFile: async (path) => {
      const value = files[String(path)];
      if (value === undefined) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return value;
    },
    loadCredentialProxy,
    resolveModel,
    loadSkills: async () => [],
    resolveTools: () => [],
    createAgent: (_options: RunnerOptions) => createFakeAgent(),
  };
}

describe("agent runner dependency boundary", () => {
  it("runs through explicit dependencies and persists a snapshot", async () => {
    const deps = dependencies({ "/workspace/AGENTS.md": "persona" });
    await expect(
      runAgentLoop("group", "session", "hello", {}, undefined, deps),
    ).resolves.toBe("");
  });

  it("keeps the public default entrypoint behavior", async () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain("personal assistant");
    expect(defaultConvertToLlm([])).toEqual([]);
  });
});

describe("defaultConvertToLlm", () => {
  const custom = (customType: "agents-snapshot" | "memory-bootstrap"): AgentMessage => ({
    role: "custom",
    customType,
    content: "content",
    display: false,
    timestamp: 1,
  });

  it("filters snapshots and converts bootstrap messages", () => {
    const result: Message[] = defaultConvertToLlm([
      custom("agents-snapshot"),
      custom("memory-bootstrap"),
      custom("memory-bootstrap"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: "user", content: "content" });
  });
});

describe("waitForNetwork", () => {
  it("retries through transient lookup failures", async () => {
    const lookupFn = vi
      .fn<(_host: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValueOnce(undefined);
    const sleepFn = vi.fn<(_ms: number) => Promise<void>>().mockResolvedValue(undefined);
    await waitForNetwork({ lookupFn, sleepFn });
    expect(lookupFn).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
  });
});

