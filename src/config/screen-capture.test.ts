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
  // port範囲・型・未知キーはそれぞれ1つ代表だけ持つ（同一validatorの複製を避ける）。
  it.each([
    null,
    { port: 65536 },
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
  it("is opt-in and keeps cron routing overrides", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({});
    await expect(
      loadScreenCaptureDailySummaryConfig(),
    ).resolves.toBeUndefined();
    vi.mocked(loadRawConfig).mockResolvedValue({
      screenCaptureDailySummary: {
        ...daily,
        botId: "screen-capture",
        model: { provider: "google", modelId: "gemini-2.5-flash" },
        tools: ["read"],
        deliveryMode: "item-thread",
        sessionMode: "destination",
      },
    });
    await expect(loadScreenCaptureDailySummaryConfig()).resolves.toMatchObject({
      ...daily,
      botId: "screen-capture",
      sessionMode: "destination",
      deliveryMode: "item-thread",
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
  // 空文字やenum不正はZod側の共通制約なので、feature固有の契約だけ残す。
  it.each([
    { startDate: "2026-02-30" }, // SQL比較が前提とする実在するISO日付
    { channelId: "" }, // 出力先は必須
    { schedule: "0 9 * * *" }, // cron job用のフィールドは受け付けない
  ])("rejects invalid daily configuration: %j", async (override) => {
    vi.mocked(loadRawConfig).mockResolvedValue({
      screenCaptureDailySummary: { ...daily, ...override },
    });
    await expect(loadScreenCaptureDailySummaryConfig()).rejects.toThrow();
  });
});
