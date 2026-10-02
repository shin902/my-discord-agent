import { describe, expect, it, vi } from "vitest";
import { loadRawConfig } from "./config.js";
import {
  loadScreenCaptureDailySummaryConfig,
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

describe("screen capture daily summary config", () => {
  const daily = {
    enabled: true,
    groupName: "logbook",
    startDate: "2026-10-03",
    prompt: "{{date}}の日次レポート",
    channelId: "123",
  };
  it("is opt-in and preserves agent and delivery overrides", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({});
    await expect(
      loadScreenCaptureDailySummaryConfig(),
    ).resolves.toBeUndefined();
    vi.mocked(loadRawConfig).mockResolvedValue({
      screenCaptureDailySummary: {
        ...daily,
        model: { provider: "google", modelId: "gemini-2.5-flash" },
        tools: ["read"],
        deliveryMode: "new-thread",
      },
    });
    await expect(loadScreenCaptureDailySummaryConfig()).resolves.toMatchObject({
      ...daily,
      sessionMode: "per-run",
      deliveryMode: "new-thread",
      tools: ["read"],
      model: { provider: "google", modelId: "gemini-2.5-flash" },
    });
    vi.mocked(loadRawConfig).mockResolvedValue({
      screenCaptureDailySummary: { ...daily, enabled: false },
    });
    await expect(
      loadScreenCaptureDailySummaryConfig(),
    ).resolves.toBeUndefined();
  });
  it.each([
    { startDate: "2026-02-30" },
    { startDate: "today" },
    { prompt: " " },
    { channelId: "" },
    { deliveryMode: "item-thread" },
    { sessionMode: "invalid" },
    { schedule: "0 9 * * *" },
  ])("rejects invalid daily configuration: %j", async (override) => {
    vi.mocked(loadRawConfig).mockResolvedValue({
      screenCaptureDailySummary: { ...daily, ...override },
    });
    await expect(loadScreenCaptureDailySummaryConfig()).rejects.toThrow();
  });
});
