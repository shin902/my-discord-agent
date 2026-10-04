import { describe, expect, it, vi } from "vitest";
import { loadCodexCloudConfig } from "./codex-cloud.js";
import { loadRawConfig } from "./config.js";

vi.mock("./config.js", () => ({ loadRawConfig: vi.fn() }));

describe("Codex Cloud config", () => {
  it.each([
    {},
    { codexCloud: {} },
    { codexCloud: { allowedEnvironments: [] } },
  ])("defaults to no authorized environments: %j", async (raw) => {
    vi.mocked(loadRawConfig).mockResolvedValue(raw);
    await expect(loadCodexCloudConfig()).resolves.toEqual({
      allowedEnvironments: [],
    });
  });

  it("preserves exact environment IDs without normalization", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({
      codexCloud: {
        allowedEnvironments: ["env_0123456789abcdef0123456789abcdef"],
      },
    });
    await expect(loadCodexCloudConfig()).resolves.toEqual({
      allowedEnvironments: ["env_0123456789abcdef0123456789abcdef"],
    });
  });

  it.each([
    null,
    { allowedEnvironments: "*" },
    { allowedEnvironments: [" env_0123456789abcdef0123456789abcdef"] },
    { allowedEnvironments: ["env_0123456789abcdef0123456789abcdef\n"] },
  ])("rejects malformed trusted config: %j", async (codexCloud) => {
    vi.mocked(loadRawConfig).mockResolvedValue({ codexCloud });
    await expect(loadCodexCloudConfig()).rejects.toThrow();
  });
});
