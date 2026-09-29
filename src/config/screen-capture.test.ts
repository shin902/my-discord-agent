import { describe, expect, it, vi } from "vitest";
import { loadRawConfig } from "./config.js";
import {
  loadScreenCaptureReceiverConfig,
  loadScreenCaptureSummaryConfig,
} from "./screen-capture.js";

vi.mock("./config.js", () => ({ loadRawConfig: vi.fn() }));

describe("screen capture receiver config", () => {
  it("is disabled by default", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({});
    await expect(loadScreenCaptureReceiverConfig()).resolves.toEqual({
      enabled: false,
      port: 8788,
    });
  });
  it.each([
    null,
    { enabled: "true" },
    { port: 0 },
    { port: 65536 },
    { port: 8788.5 },
    { host: "0.0.0.0" },
  ])("fails closed: %j", async (config) => {
    vi.mocked(loadRawConfig).mockResolvedValue({
      screenCaptureReceiver: config,
    });
    await expect(loadScreenCaptureReceiverConfig()).rejects.toThrow();
  });
});

describe("screen capture summary config", () => {
  it("is disabled unless explicitly configured", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({});
    await expect(loadScreenCaptureSummaryConfig()).resolves.toBeUndefined();
  });

  it("validates the batch settings when enabled", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({
      screenCaptureSummary: {
        enabled: true,
        groupName: "logbook",
        settings: { mode: "direct", limit: 2 },
      },
    });
    await expect(loadScreenCaptureSummaryConfig()).resolves.toMatchObject({
      groupName: "logbook",
      settings: { mode: "direct", limit: 2 },
    });
    vi.mocked(loadRawConfig).mockResolvedValue({
      screenCaptureSummary: {
        enabled: true,
        groupName: "logbook",
        settings: { mode: "direct", limit: 0 },
      },
    });
    await expect(loadScreenCaptureSummaryConfig()).rejects.toThrow();
  });
});
