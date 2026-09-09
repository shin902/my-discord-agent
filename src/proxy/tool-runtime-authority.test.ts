import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as runtime from "../runtime/tool-runtime-client.js";
import { resolveTools } from "../tools/registry.js";
import { runCapabilityNames } from "../tools/skill-capabilities.js";
import { requestToolProxy } from "../tools/tool-proxy.js";
import type { ToolApprovalRequest } from "./tool-approval.js";
import {
  createToolProxyRequestHandler,
  createToolProxyRun,
  initToolProxyServer,
  stopToolProxyServer,
} from "./tool-proxy-server.js";

const execFileAsync = promisify(execFile);
let directory: string;
let url: string;
let present: (request: ToolApprovalRequest) => Promise<void>;
const server = createServer(
  createToolProxyRequestHandler({
    presentApprovalRequest: (request) => present(request),
  }),
);
beforeAll(async () => {
  await initToolProxyServer();
  directory = await mkdtemp(join(tmpdir(), "runtime-authority-cli-"));
  await writeFile(
    join(directory, "tool-proxy"),
    `#!/bin/sh\nexec node --import tsx "${process.cwd()}/src/sandbox/tool-proxy-cli.ts" "$@"\n`,
    { mode: 0o700 },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  url = `http://127.0.0.1:${address.port}/__tool-proxy/rpc`;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
function cli(token: string, capability: string, args: unknown) {
  return execFileAsync(
    join(directory, "tool-proxy"),
    [capability, JSON.stringify(args)],
    {
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: "/dev/null",
        TOOL_PROXY_URL: url,
        TOOL_PROXY_TOKEN: token,
      },
    },
  );
}
function authority(
  tools: string[],
  skills: string[],
  approval: string[] = [],
  groupName?: string,
) {
  const config = createToolProxyRun(
    "runtime-authority",
    runCapabilityNames({ tools, skills }),
    {
      ...(groupName ? { groupName } : {}),
      approvalRequiredCapabilities: approval,
      trustedDiscordDestination: {
        botId: "personal",
        channelId: "fixture-channel",
      },
    },
  );
  if (!config) throw new Error("not initialized");
  return config;
}

describe("Native/Skill shared Runtime authority", () => {
  it.each([
    { tools: ["arxiv-search"], skills: [] },
    { tools: ["arxiv-search"], skills: ["arxiv-search"] },
  ])("applies the same approval and effective args to native and CLI: %j", async ({
    tools,
    skills,
  }) => {
    const execute = vi.spyOn(runtime, "executeToolRuntime").mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
      details: {},
    });
    const run = authority(tools, skills, ["arxiv-search"]);
    const presented: unknown[] = [];
    present = async (request) => {
      presented.push(request.invocation.args.value);
      expect(execute).toHaveBeenCalledTimes(presented.length - 1);
      request.claim("approve")?.completeUiUpdate();
    };
    try {
      const [native] = resolveTools(
        tools,
        {},
        { toolProxyEndpoint: { url, token: run.token } },
      );
      await native.execute("native", {
        query: "q",
        max_results: 99,
        ignored: "removed",
      });
      const result = await cli(run.token, "arxiv-search", {
        query: "q",
        max_results: 99,
        ignored: "removed",
      });
      expect(result.stdout).toBe("[]");
      expect(presented).toEqual([
        { query: "q", max_results: 50, sort: "relevance" },
        { query: "q", max_results: 50, sort: "relevance" },
      ]);
      expect(execute.mock.calls.map((call) => call[1])).toEqual(presented);
    } finally {
      run.revoke();
    }
  });

  it("supports Skill-only authority but rejects unselected, maintenance and revoked capabilities", async () => {
    const execute = vi.spyOn(runtime, "executeToolRuntime").mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
      details: {},
    });
    const run = authority([], ["arxiv-search"]);
    try {
      expect(
        (await cli(run.token, "arxiv-search", { query: "q" })).stdout,
      ).toBe("[]");
      await expect(
        cli(run.token, "arxiv-survey", { queries: ["q"] }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("not authorized"),
      });
      await expect(
        cli(run.token, "reddit-cookie-refresh", {}),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("Unknown capability"),
      });
      run.revoke();
      await expect(
        cli(run.token, "arxiv-search", { query: "q" }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("expired run token"),
      });
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      run.revoke();
    }
  });

  it("denied Skill approval cannot execute through a native-selected capability", async () => {
    const execute = vi
      .spyOn(runtime, "executeToolRuntime")
      .mockResolvedValue({ content: [], details: {} });
    const run = authority(["agent-reach"], [], ["agent-reach"]);
    present = async (request) => {
      request.claim("deny")?.completeUiUpdate();
    };
    try {
      await expect(
        cli(run.token, "agent-reach", { url: "https://example.com" }),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining("approval failed"),
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      run.revoke();
    }
  });

  it("run revoke aborts a currently executing call even without approval", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execute = vi
      .spyOn(runtime, "executeToolRuntime")
      .mockImplementation(async (_capability, _args, signal) => {
        started();
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new Error("runtime aborted")),
            { once: true },
          ),
        );
        return { content: [], details: {} };
      });
    const run = authority([], ["arxiv-search"]);
    const pending = requestToolProxy(
      "arxiv-search",
      { query: "q" },
      { url, token: run.token },
    );
    const outcome = expect(pending).rejects.toThrow("runtime aborted");
    await ready;
    run.revoke();
    await outcome;
    expect(execute.mock.calls[0][2]?.aborted).toBe(true);
  });
  it("disconnect cancels an execution without waiting for run revocation", async () => {
    let started!: () => void;
    let cancelled!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    vi.spyOn(runtime, "executeToolRuntime").mockImplementation(
      async (_name, _args, signal) => {
        started();
        await new Promise<void>((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => {
              cancelled();
              reject(new Error("disconnected"));
            },
            { once: true },
          ),
        );
        return { content: [], details: {} };
      },
    );
    const run = authority([], ["agent-reach"]);
    const controller = new AbortController();
    try {
      const pending = requestToolProxy(
        "agent-reach",
        { url: "https://example.com" },
        { url, token: run.token },
        controller.signal,
      );
      const outcome = expect(pending).rejects.toThrow();
      await ready;
      controller.abort();
      await outcome;
      await stopped;
    } finally {
      run.revoke();
    }
  });

  it("disconnect during approval prevents any later Runtime launch", async () => {
    const execute = vi
      .spyOn(runtime, "executeToolRuntime")
      .mockResolvedValue({ content: [], details: {} });
    let shown!: (request: ToolApprovalRequest) => void;
    const ready = new Promise<ToolApprovalRequest>((resolve) => {
      shown = resolve;
    });
    present = async (request) => {
      shown(request);
    };
    const run = authority(["agent-reach"], [], ["agent-reach"]);
    const controller = new AbortController();
    try {
      const pending = requestToolProxy(
        "agent-reach",
        { url: "https://example.com" },
        { url, token: run.token },
        controller.signal,
      );
      const outcome = expect(pending).rejects.toThrow();
      const approval = await ready;
      controller.abort();
      await outcome;
      await expect(approval.waitForDecision()).rejects.toThrow("revoked");
      expect(approval.claim("approve")).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      run.revoke();
    }
  });

  it("passes only the trusted group context to finance Runtime calls", async () => {
    const execute = vi.spyOn(runtime, "executeToolRuntime").mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
      details: {},
    });
    const run = authority(["finance-record-transaction"], [], [], "local");
    try {
      await expect(
        cli(run.token, "finance-record-transaction", {
          type: "expense",
          amount: 800,
        }),
      ).resolves.toMatchObject({ stdout: "{}" });
      expect(execute).toHaveBeenCalledWith(
        "finance-record-transaction",
        { type: "expense", amount: 800 },
        expect.any(AbortSignal),
        { groupName: "local" },
      );

      const missingGroup = createToolProxyRun("finance-no-group", [
        "finance-summary",
      ]);
      if (!missingGroup) throw new Error("not initialized");
      try {
        await expect(
          cli(missingGroup.token, "finance-summary", {}),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("trusted group context"),
        });
      } finally {
        missingGroup.revoke();
      }
    } finally {
      run.revoke();
    }
  });

  it("shutdown revokes active runs and closes new run admission", async () => {
    const run = authority([], ["arxiv-search"]);
    try {
      await stopToolProxyServer();
      expect(
        createToolProxyRun("after-shutdown", ["arxiv-search"]),
      ).toBeUndefined();
      await expect(
        requestToolProxy(
          "arxiv-search",
          { query: "q" },
          { url, token: run.token },
        ),
      ).rejects.toThrow("expired run token");
    } finally {
      run.revoke();
      await initToolProxyServer();
    }
  });
});
