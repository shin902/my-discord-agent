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
        allowedEnvironments: ["shin902/orca", " Other/Repo "],
      },
    });
    await expect(loadCodexCloudConfig()).resolves.toEqual({
      allowedEnvironments: ["shin902/orca", " Other/Repo "],
    });
  });

  it.each([
    null,
    { allowedEnvironments: "*" },
    { allowedEnvironments: [""] },
    { allowedEnvironments: [1] },
    { executable: "sh" },
  ])("rejects malformed trusted config: %j", async (codexCloud) => {
    vi.mocked(loadRawConfig).mockResolvedValue({ codexCloud });
    await expect(loadCodexCloudConfig()).rejects.toThrow();
  });
});
