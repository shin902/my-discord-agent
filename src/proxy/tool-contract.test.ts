import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { getCapabilityDefinition } from "../tools/registry.js";
import { describeToolProxy, requestToolProxy } from "../tools/tool-proxy.js";
import { runCapabilityNames, TOOL_SETS } from "../tools/tool-sets.js";
import {
  createToolProxyRun,
  initToolProxyServer,
  stopToolProxyServer,
} from "./tool-proxy-server.js";

const execFileAsync = promisify(execFile);
let directory: string;
let url: string;
const present = vi.fn();
beforeAll(async () => {
  const port = await initToolProxyServer({ presentApprovalRequest: present });
  url = `http://127.0.0.1:${port}/__tool-proxy/rpc`;
  directory = await mkdtemp(join(tmpdir(), "tool-contract-"));
  await writeFile(
    join(directory, "tool-proxy"),
    `#!/bin/sh\nexec node --import tsx "${resolve("src/sandbox/tool-proxy-cli.ts")}" "$@"\n`,
    { mode: 0o700 },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  present.mockClear();
});
afterAll(async () => {
  await stopToolProxyServer();
  await rm(directory, { recursive: true, force: true });
});

function run(toolSets: string[], approval: string[] = []) {
  const config = createToolProxyRun(
    "contract-test",
    runCapabilityNames({ tools: [], toolSets }),
    { approvalRequiredCapabilities: approval },
  );
  if (!config) throw new Error("not initialized");
  return { ...config, url };
}

function script(skill: string, token: string, ...args: string[]) {
  return execFileAsync(
    "bash",
    [resolve(`templates/SKILLS/${skill}/scripts/${skill}.sh`), ...args],
    {
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: "/dev/null",
        PATH: `${directory}:${process.env.PATH}`,
        TOOL_PROXY_URL: url,
        TOOL_PROXY_TOKEN: token,
      },
    },
  );
}

describe("authorized Tool contract discovery", () => {
  it.each(
    Object.entries(TOOL_SETS),
  )("describes canonical %s contracts without approval or execution", async (bundle, names) => {
    const endpoint = run([bundle], [...names]);
    const executeRuntime = vi.spyOn(runtime, "executeToolRuntime");
    try {
      for (const name of names) {
        const definition = getCapabilityDefinition(name);
        const tool = definition?.factory();
        if (!tool || !definition) throw new Error(`missing tool ${name}`);
        const execute = vi.spyOn(tool, "execute");
        const factory = vi.spyOn(definition, "factory").mockReturnValue(tool);
        const contract = await describeToolProxy(name, endpoint);
        expect(contract).toEqual(
          JSON.parse(
            JSON.stringify({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            }),
          ),
        );
        expect(contract.description).not.toBe("");
        expect(factory).toHaveBeenCalledOnce();
        expect(execute).not.toHaveBeenCalled();
      }
      expect(present).not.toHaveBeenCalled();
      expect(executeRuntime).not.toHaveBeenCalled();
    } finally {
      endpoint.revoke();
    }
  });

  it("requires current authority for discovery and does not leak unauthorized contracts", async () => {
    const endpoint = run([]);
    try {
      const definition = getCapabilityDefinition("delete-event");
      if (!definition) throw new Error("missing capability");
      const factory = vi.spyOn(definition, "factory");
      for (const token of ["", "unknown"]) {
        await expect(
          describeToolProxy("delete-event", { url, token }),
        ).rejects.toThrow(/token/);
      }
      await expect(describeToolProxy("delete-event", endpoint)).rejects.toThrow(
        "not authorized",
      );
      await expect(
        requestToolProxy("delete-event", {}, endpoint),
      ).rejects.toThrow("not authorized");
      expect(factory).not.toHaveBeenCalled();
      endpoint.revoke();
      await expect(describeToolProxy("delete-event", endpoint)).rejects.toThrow(
        "expired run token",
      );
    } finally {
      endpoint.revoke();
    }
  });

  it.each([
    ["web", "arxiv-search", { query: "q" }],
    ["github", "read-issue", { owner: "owner", repo: "repo", issue_number: 1 }],
    ["mail", "list-emails", {}],
    ["calendar", "delete-event", { eventId: "event", calendarId: "primary" }],
    ["weather", "get-current-weather", { location: "Tokyo" }],
  ] as const)("%s script discovers before executing raw JSON", async (skill, name, args) => {
    const endpoint = run([skill]);
    const tool = getCapabilityDefinition(name)?.factory();
    if (!tool) throw new Error("missing tool");
    const result = {
      content: [{ type: "text" as const, text: "fixture" }],
      details: {},
    };
    const hostExecute = vi.spyOn(tool, "execute").mockResolvedValue(result);
    const runtimeExecute = vi
      .spyOn(runtime, "executeToolRuntime")
      .mockResolvedValue(result);
    try {
      const discovered = JSON.parse(
        (await script(skill, endpoint.token, name)).stdout,
      );
      expect(discovered.description).toBe(tool.description);
      expect(discovered.parameters).toEqual(
        JSON.parse(JSON.stringify(tool.parameters)),
      );
      expect(hostExecute).not.toHaveBeenCalled();
      expect(runtimeExecute).not.toHaveBeenCalled();
      expect(
        (await script(skill, endpoint.token, name, JSON.stringify(args)))
          .stdout,
      ).toBe("fixture");
      expect(
        hostExecute.mock.calls.length + runtimeExecute.mock.calls.length,
      ).toBe(1);
    } finally {
      endpoint.revoke();
    }
  });
});
