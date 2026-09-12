import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRawCron } from "../config/config.js";
import { loadMemoryCoreConnectionSettingsFromCron } from "./cron-settings.js";

vi.mock("../config/config.js", () => ({ loadRawCron: vi.fn() }));

const mockedLoadRawCron = vi.mocked(loadRawCron);

afterEach(() => vi.resetAllMocks());

describe("MemoryCore cron settings", () => {
  it.each([
    "jobs/memory-export.ts",
    "./jobs/memory-export.ts",
    "jobs/memory-export.js",
  ])("uses loader-accepted handler identity %s", async (handler) => {
    mockedLoadRawCron.mockResolvedValue([
      { id: "other", handler: "jobs/mail.ts", settings: {} },
      {
        id: "memory-main",
        handler,
        settings: {
          type: "tencentdb",
          baseUrl: "https://memory.example/base",
          serviceId: "service",
          teamId: "team",
          agentId: "agent",
          bearerTokenEnv: "MEMORY_SECRET",
          timeoutMs: 1234,
          eligibleGroups: ["main"],
        },
      },
    ]);

    await expect(loadMemoryCoreConnectionSettingsFromCron()).resolves.toEqual({
      baseUrl: "https://memory.example/base",
      serviceId: "service",
      teamId: "team",
      agentId: "agent",
      bearerTokenEnv: "MEMORY_SECRET",
      timeoutMs: 1234,
    });
  });

  it.each([
    { jobs: [] },
    { jobs: [{ handler: "jobs/mail.ts", settings: {} }] },
  ])("rejects when no MemoryCore export profile exists", async ({ jobs }) => {
    mockedLoadRawCron.mockResolvedValue(jobs);
    await expect(loadMemoryCoreConnectionSettingsFromCron()).rejects.toThrow(
      "exactly one",
    );
  });

  it("rejects ambiguous MemoryCore export profiles", async () => {
    const job = {
      handler: "jobs/memory-export.ts",
      settings: { type: "tencentdb" },
    };
    mockedLoadRawCron.mockResolvedValue([job, job]);
    await expect(loadMemoryCoreConnectionSettingsFromCron()).rejects.toThrow(
      "exactly one",
    );
  });
});
