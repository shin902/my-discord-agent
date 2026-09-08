import { describe, expect, it, vi } from "vitest";
import { loadRawConfig } from "./config.js";
import { loadXSavedReceiverConfig } from "./x-saved.js";

vi.mock("./config.js", () => ({ loadRawConfig: vi.fn() }));

describe("x-saved receiver config", () => {
  it("defaults to disabled", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({});
    await expect(loadXSavedReceiverConfig()).resolves.toEqual({
      enabled: false,
      port: 8787,
    });
  });
  it.each([
    null,
    { port: 0 },
    { port: 65536 },
    { port: "8787" },
    { enabled: "true" },
    { host: "0.0.0.0" },
  ])("fails closed for invalid config %j", async (config) => {
    vi.mocked(loadRawConfig).mockResolvedValue({ xSavedReceiver: config });
    await expect(loadXSavedReceiverConfig()).rejects.toThrow();
  });
});
