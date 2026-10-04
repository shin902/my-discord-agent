import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { loadRawConfig } from "../config/config.js";
import type { ToolApprovalRequest } from "../proxy/tool-approval.js";
import {
  createToolProxyRun,
  initToolProxyServer,
  stopToolProxyServer,
} from "../proxy/tool-proxy-server.js";
import { getCapabilityDefinition, resolveTools } from "./registry.js";

vi.mock("../config/config.js", () => ({ loadRawConfig: vi.fn() }));

const args = {
  environment: "shin902/orca",
  branch: "feature/$(touch nope);not-a-shell",
  prompt: "--config danger=true\nDo the work; $(touch nope)",
};
const capability = getCapabilityDefinition("codex-cloud-submit");
if (!capability || capability.executor !== "host") {
  throw new Error("Codex Cloud must be registered as a host capability");
}
const hostTool = capability.factory();
if (!hostTool) throw new Error("Codex Cloud host tool is unavailable");
let directory: string;

async function installCli(body: string) {
  await writeFile(join(directory, "codex"), `#!${process.execPath}\n${body}`, {
    mode: 0o700,
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "codex-cloud-test-"));
  vi.stubEnv("PATH", `${directory}:${process.env.PATH}`);
  vi.mocked(loadRawConfig).mockResolvedValue({
    codexCloud: { allowedEnvironments: [args.environment] },
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  await rm(directory, { recursive: true, force: true });
});
afterAll(() => stopToolProxyServer());

describe("Codex Cloud submission", () => {
  it("uses the existing approval gate and returns fixed CLI argv stdout through the native proxy", async () => {
    await installCli(
      "process.stdout.write(JSON.stringify(process.argv.slice(2))); ",
    );
    let presented!: ToolApprovalRequest;
    let notify!: () => void;
    const ready = new Promise<void>((resolve) => {
      notify = resolve;
    });
    const port = await initToolProxyServer({
      presentApprovalRequest: async (request) => {
        presented = request;
        notify();
      },
    });
    const run = createToolProxyRun("codex-test", ["codex-cloud-submit"], {
      approvalRequiredCapabilities: ["codex-cloud-submit"],
      trustedDiscordDestination: { botId: "personal", channelId: "channel-1" },
    });
    if (!run) throw new Error("Tool Proxy unavailable");
    try {
      const [tool] = resolveTools(
        ["codex-cloud-submit"],
        {},
        {
          toolProxyEndpoint: {
            url: `http://127.0.0.1:${port}/__tool-proxy/rpc`,
            token: run.token,
          },
        },
      );
      const pending = tool.execute("submit", args);
      await ready;
      expect(loadRawConfig).not.toHaveBeenCalled();
      expect(presented.invocation.args.value).toEqual(args);
      expect(presented.claim("approve")?.completeUiUpdate()).toBe(true);
      expect(await pending).toEqual({
        content: [
          {
            type: "text",
            text: JSON.stringify([
              "cloud",
              "exec",
              "--env",
              args.environment,
              "--branch",
              args.branch,
              "--",
              args.prompt,
            ]),
          },
        ],
        details: {},
      });
      expect(await readdir(directory)).toEqual(["codex"]);
    } finally {
      run.revoke();
    }
  });

  it.each([
    {},
    { codexCloud: { allowedEnvironments: [] } },
    { codexCloud: { allowedEnvironments: ["shin902/orca-other"] } },
    { codexCloud: { allowedEnvironments: ["SHIN902/ORCA"] } },
  ])("rejects unauthorized environments before starting the CLI: %j", async (config) => {
    vi.mocked(loadRawConfig).mockResolvedValue(config);
    await installCli(
      `require('node:fs').writeFileSync(${JSON.stringify(join(directory, "started"))}, 'yes');`,
    );
    await expect(hostTool.execute("submit", args)).rejects.toThrow(
      "environment is not allowed",
    );
    expect(await readdir(directory)).toEqual(["codex"]);
  });

  it("includes the CLI exit code and stderr on failure", async () => {
    await installCli(
      "process.stderr.write('branch does not exist'); process.exitCode = 7;",
    );
    await expect(hostTool.execute("submit", args)).rejects.toThrow(
      "codex cloud exec failed (exit 7): branch does not exist",
    );
  });

  it("propagates spawn diagnostics when codex is missing", async () => {
    vi.stubEnv("PATH", directory);
    await expect(hostTool.execute("submit", args)).rejects.toThrow(
      "spawn codex ENOENT",
    );
  });

  it("aborts an already running CLI process", async () => {
    const started = join(directory, "started");
    await installCli(
      `require('node:fs').writeFileSync(${JSON.stringify(started)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const controller = new AbortController();
    const pending = expect(
      hostTool.execute("submit", args, controller.signal),
    ).rejects.toThrow("aborted");
    try {
      await vi.waitFor(async () =>
        expect(await readFile(started, "utf8")).toMatch(/^\d+$/),
      );
    } finally {
      controller.abort();
    }
    await pending;
    const pid = Number(await readFile(started, "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });
});
