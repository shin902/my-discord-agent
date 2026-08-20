import { describe, expect, it, vi } from "vitest";
import type { JsonValue } from "../config/config.js";
import { NonRetryableError } from "../utils/error.js";
import { createCronRunner, type CronRunnerDependencies } from "./runner.js";

function harness(raw: JsonValue) {
  const loadRawCron = vi
    .fn<NonNullable<CronRunnerDependencies["loadRawCron"]>>()
    .mockResolvedValue(raw);
  const runner = createCronRunner({
    loadRawCron,
    appendInbox: vi.fn().mockResolvedValue(undefined),
    resolveTools: vi.fn(),
  });
  return { runner, loadRawCron };
}

const groupJob = {
  id: "group",
  schedule: "5m",
  groupName: "g",
  prompt: "p",
  channelId: "c",
  deliveryMode: "direct",
  sessionMode: "per-run",
};

describe("cron schema validation", () => {
  it("rejects duplicate IDs and incomplete jobs", async () => {
    await expect(
      harness([{ ...groupJob }, { ...groupJob }]).runner.loadAndValidateCron(),
    ).rejects.toThrow();
    await expect(
      harness([
        { id: "missing", schedule: "* * * * *" },
      ]).runner.loadAndValidateCron(),
    ).rejects.toThrow();
  });
  it("returns an empty list for ENOENT", async () => {
    const error = Object.assign(new Error("missing"), { code: "ENOENT" });
    const loadRawCron = vi
      .fn<NonNullable<CronRunnerDependencies["loadRawCron"]>>()
      .mockRejectedValue(error);
    expect(
      await createCronRunner({ loadRawCron }).loadAndValidateCron(),
    ).toEqual([]);
  });
  it("accepts handler and group jobs, settings, and legacy mode", async () => {
    const { runner } = harness([
      {
        id: "handler",
        schedule: "* * * * *",
        handler: "__fixtures__/test-handler.ts",
        settings: { maxResults: 10 },
      },
      groupJob,
      {
        id: "legacy",
        schedule: "5m",
        groupName: "g",
        prompt: "p",
        channelId: "c",
        mode: "to-channel",
      },
    ]);
    await expect(runner.loadAndValidateCron()).resolves.toHaveLength(3);
  });
  it("rejects invalid mode combinations and handlers", async () => {
    await expect(
      harness([
        {
          id: "partial",
          schedule: "5m",
          groupName: "g",
          prompt: "p",
          channelId: "c",
          deliveryMode: "direct",
        },
      ]).runner.loadAndValidateCron(),
    ).rejects.toThrow();
    await expect(
      harness([
        {
          id: "mixed",
          schedule: "5m",
          groupName: "g",
          prompt: "p",
          channelId: "c",
          mode: "to-channel",
          deliveryMode: "direct",
          sessionMode: "per-run",
        },
      ]).runner.loadAndValidateCron(),
    ).rejects.toThrow();
    await expect(
      harness([
        { id: "bad", schedule: "* * * * *", handler: "jobs/nonexistent.ts" },
      ]).runner.loadAndValidateCron(),
    ).rejects.toThrow();
    await expect(
      harness([
        { id: "bad", schedule: "* * * * *", handler: "../evil.ts" },
      ]).runner.loadAndValidateCron(),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
  it("skips validation for disabled handlers and preserves settings", async () => {
    const { runner } = harness([
      {
        id: "disabled",
        schedule: "* * * * *",
        enabled: false,
        handler: "jobs/nonexistent.ts",
        settings: { x: true },
      },
    ]);
    await expect(runner.loadAndValidateCron()).resolves.toEqual([
      expect.objectContaining({ settings: { x: true } }),
    ]);
  });
});

describe("handler path resolution", () => {
  const runner = createCronRunner();
  it.each([
    "../evil.ts",
    "..\\evil.ts",
    "jobs/../../evil.ts",
    "/etc/passwd.ts",
  ])("rejects %s", async (handler) => {
    await expect(runner.loadHandlerFn(handler)).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });
  it("loads a valid handler", async () => {
    await expect(
      runner.loadHandlerFn("__fixtures__/test-handler.ts"),
    ).resolves.toBeTypeOf("function");
  });
});
