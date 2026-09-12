import { describe, expect, it, vi } from "vitest";
import { loadRawConfig } from "./config.js";
import {
  loadXSavedGalleryConfig,
  loadXSavedReceiverConfig,
} from "./x-saved.js";

vi.mock("./config.js", () => ({ loadRawConfig: vi.fn() }));

describe("x-saved gallery config", () => {
  it("defaults to disabled and a separate port", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({});
    await expect(loadXSavedGalleryConfig()).resolves.toEqual({
      enabled: false,
      port: 8789,
    });
    const config = {
      enabled: true,
      origin: "https://gallery.example.ts.net",
    };
    vi.mocked(loadRawConfig).mockResolvedValue({ xSavedGallery: config });
    await expect(loadXSavedGalleryConfig()).resolves.toEqual({
      ...config,
      port: 8789,
    });
  });
  it.each([
    null,
    { enabled: true },
    { port: 0 },
    { port: 65536 },
    { port: "8789" },
    { host: "0.0.0.0" },
    { allowedLogin: "owner@example.com" },
    { origin: "http://gallery.example.ts.net" },
    { origin: "https://example.com" },
    { origin: "https://gallery.example.ts.net/path" },
    { origin: "https://gallery.example.ts.net/" },
    { origin: "https://user@gallery.example.ts.net" },
    { enabled: "true" },
  ])("rejects invalid gallery config %j", async (config) => {
    vi.mocked(loadRawConfig).mockResolvedValue({ xSavedGallery: config });
    await expect(loadXSavedGalleryConfig()).rejects.toThrow();
  });
});

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
