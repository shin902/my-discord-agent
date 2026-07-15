import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cronMatches,
  isCronExpr,
  matchField,
  parseIntervalMs,
  shouldRun,
} from "./runner.js";

// ヘルパー: ローカル時刻で Date を生成（cronMatches はローカル時刻メソッドを使う）
function localDate(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  s: number = 0,
  ms: number = 0,
): Date {
  return new Date(y, m, d, h, min, s, ms);
}

// --- matchField ---

describe("matchField", () => {
  it("wildcard (*) always matches", () => {
    expect(matchField(0, "*")).toBe(true);
    expect(matchField(59, "*")).toBe(true);
    expect(matchField(23, "*")).toBe(true);
    expect(matchField(31, "*")).toBe(true);
  });

  it("exact match", () => {
    expect(matchField(5, "5")).toBe(true);
    expect(matchField(10, "10")).toBe(true);
    expect(matchField(5, "10")).toBe(false);
  });

  it("step (*/n)", () => {
    expect(matchField(0, "*/5")).toBe(true);
    expect(matchField(5, "*/5")).toBe(true);
    expect(matchField(10, "*/5")).toBe(true);
    expect(matchField(3, "*/5")).toBe(false);
    expect(matchField(7, "*/3")).toBe(false);
    expect(matchField(9, "*/3")).toBe(true);
  });

  it("range (a-b)", () => {
    expect(matchField(5, "1-10")).toBe(true);
    expect(matchField(1, "1-10")).toBe(true);
    expect(matchField(10, "1-10")).toBe(true);
    expect(matchField(0, "1-10")).toBe(false);
    expect(matchField(11, "1-10")).toBe(false);
  });

  it("list (a,b,c)", () => {
    expect(matchField(1, "1,5,10")).toBe(true);
    expect(matchField(5, "1,5,10")).toBe(true);
    expect(matchField(10, "1,5,10")).toBe(true);
    expect(matchField(3, "1,5,10")).toBe(false);
  });

  it("list with whitespace trimming", () => {
    expect(matchField(5, "1, 5, 10")).toBe(true);
  });
});

// --- cronMatches ---

describe("cronMatches", () => {
  it("matches simple expression", () => {
    // "30 12 * * *" = every day at 12:30
    const date = localDate(2025, 0, 15, 12, 30);
    expect(cronMatches("30 12 * * *", date)).toBe(true);
  });

  it("does not match when minute differs", () => {
    const date = localDate(2025, 0, 15, 12, 31);
    expect(cronMatches("30 12 * * *", date)).toBe(false);
  });

  it("does not match when hour differs", () => {
    const date = localDate(2025, 0, 15, 13, 30);
    expect(cronMatches("30 12 * * *", date)).toBe(false);
  });

  it("matches step expression", () => {
    // "*/15 * * * *" = every 15 minutes
    const d1 = localDate(2025, 0, 1, 0, 0);
    const d2 = localDate(2025, 0, 1, 0, 15);
    const d3 = localDate(2025, 0, 1, 0, 30);
    const d4 = localDate(2025, 0, 1, 0, 45);
    const d5 = localDate(2025, 0, 1, 0, 7);
    expect(cronMatches("*/15 * * * *", d1)).toBe(true);
    expect(cronMatches("*/15 * * * *", d2)).toBe(true);
    expect(cronMatches("*/15 * * * *", d3)).toBe(true);
    expect(cronMatches("*/15 * * * *", d4)).toBe(true);
    expect(cronMatches("*/15 * * * *", d5)).toBe(false);
  });

  it("matches day-of-week field", () => {
    // "0 9 * * 1" = Monday at 9:00
    // 2025-01-06 is a Monday (getDay() === 1)
    const monday = localDate(2025, 0, 6, 9, 0);
    const tuesday = localDate(2025, 0, 7, 9, 0);
    expect(cronMatches("0 9 * * 1", monday)).toBe(true);
    expect(cronMatches("0 9 * * 1", tuesday)).toBe(false);
  });

  it("matches month field (JS getMonth is 0-indexed, cronMatches adds 1)", () => {
    // "0 0 1 6 *" = June 1st at midnight
    const june = localDate(2025, 5, 1, 0, 0);
    const may = localDate(2025, 4, 1, 0, 0);
    expect(cronMatches("0 0 1 6 *", june)).toBe(true);
    expect(cronMatches("0 0 1 6 *", may)).toBe(false);
  });

  it("returns false for malformed expression", () => {
    expect(cronMatches("* * *", new Date())).toBe(false);
    expect(cronMatches("*", new Date())).toBe(false);
    expect(cronMatches("", new Date())).toBe(false);
  });

  it("trims and splits on whitespace", () => {
    const date = localDate(2025, 0, 15, 12, 30);
    expect(cronMatches("  30  12  *  *  *  ", date)).toBe(true);
  });
});

// --- isCronExpr ---

describe("isCronExpr", () => {
  it("returns true for 5-field expressions", () => {
    expect(isCronExpr("* * * * *")).toBe(true);
    expect(isCronExpr("30 12 * * *")).toBe(true);
  });

  it("returns false for interval shorthand", () => {
    expect(isCronExpr("5m")).toBe(false);
    expect(isCronExpr("1h")).toBe(false);
  });

  it("returns false for other formats", () => {
    expect(isCronExpr("* * *")).toBe(false);
    expect(isCronExpr("")).toBe(false);
  });
});

// --- parseIntervalMs ---

describe("parseIntervalMs", () => {
  it("parses minute intervals", () => {
    expect(parseIntervalMs("5m")).toBe(5 * 60_000);
    expect(parseIntervalMs("1m")).toBe(60_000);
    expect(parseIntervalMs("60m")).toBe(60 * 60_000);
  });

  it("parses hour intervals", () => {
    expect(parseIntervalMs("1h")).toBe(3_600_000);
    expect(parseIntervalMs("2h")).toBe(2 * 3_600_000);
    expect(parseIntervalMs("24h")).toBe(24 * 3_600_000);
  });

  it("returns null for cron expressions", () => {
    expect(parseIntervalMs("* * * * *")).toBe(null);
    expect(parseIntervalMs("30 12 * * *")).toBe(null);
  });

  it("returns null for invalid formats", () => {
    expect(parseIntervalMs("5x")).toBe(null);
    expect(parseIntervalMs("m")).toBe(null);
    expect(parseIntervalMs("h")).toBe(null);
    expect(parseIntervalMs("")).toBe(null);
    expect(parseIntervalMs("5 min")).toBe(null);
  });
});

// --- shouldRun ---

describe("shouldRun", () => {
  describe("cron expression mode", () => {
    it("runs on first execution (lastRun is null)", () => {
      const now = localDate(2025, 0, 15, 12, 30, 5);
      expect(shouldRun("30 12 * * *", null, now)).toBe(true);
    });

    it("does not run when cron does not match", () => {
      const now = localDate(2025, 0, 15, 12, 31, 5);
      expect(shouldRun("30 12 * * *", null, now)).toBe(false);
    });

    it("does not run when lastRun is in the same minute (regression: commit 1268881)", () => {
      // lastRun at 12:30:00, now at 12:30:45 — same minute, should NOT run
      const lastRun = localDate(2025, 0, 15, 12, 30, 0);
      const now = localDate(2025, 0, 15, 12, 30, 45);
      expect(shouldRun("30 12 * * *", lastRun, now)).toBe(false);
    });

    it("does not run when lastRun equals floored now exactly", () => {
      // lastRun at 12:30:00, now at 12:30:00 — floored <= lastRun
      const lastRun = localDate(2025, 0, 15, 12, 30, 0);
      const now = localDate(2025, 0, 15, 12, 30, 0);
      expect(shouldRun("30 12 * * *", lastRun, now)).toBe(false);
    });

    it("runs when lastRun is just before the current minute", () => {
      // lastRun at 12:29:59, now at 12:30:01 — floored (12:30:00) > lastRun
      const lastRun = localDate(2025, 0, 15, 12, 29, 59);
      const now = localDate(2025, 0, 15, 12, 30, 1);
      expect(shouldRun("30 12 * * *", lastRun, now)).toBe(true);
    });

    it("runs when lastRun is well before the current minute", () => {
      const lastRun = localDate(2025, 0, 15, 11, 30, 0);
      const now = localDate(2025, 0, 15, 12, 30, 0);
      expect(shouldRun("30 12 * * *", lastRun, now)).toBe(true);
    });

    it("does not run when lastRun is after floored now", () => {
      // lastRun at 12:30:00, now at 12:29:59 — floored (12:29:00) <= lastRun
      const lastRun = localDate(2025, 0, 15, 12, 30, 0);
      const now = localDate(2025, 0, 15, 12, 29, 59);
      expect(shouldRun("30 12 * * *", lastRun, now)).toBe(false);
    });

    it("ignores seconds when flooring for cron match", () => {
      // now at 12:30:59 should still match "30 12 * * *"
      const lastRun = localDate(2025, 0, 15, 12, 29, 0);
      const now = localDate(2025, 0, 15, 12, 30, 59);
      expect(shouldRun("30 12 * * *", lastRun, now)).toBe(true);
    });

    it("handles wildcard cron every minute", () => {
      const lastRun = localDate(2025, 0, 15, 12, 29, 0);
      const now = localDate(2025, 0, 15, 12, 30, 0);
      expect(shouldRun("* * * * *", lastRun, now)).toBe(true);
    });

    it("does not re-run within same minute for wildcard", () => {
      const lastRun = localDate(2025, 0, 15, 12, 30, 0);
      const now = localDate(2025, 0, 15, 12, 30, 30);
      expect(shouldRun("* * * * *", lastRun, now)).toBe(false);
    });
  });

  describe("interval mode", () => {
    it("runs on first execution (lastRun is null)", () => {
      const now = localDate(2025, 0, 15, 12, 0, 0);
      expect(shouldRun("5m", null, now)).toBe(true);
    });

    it("runs when interval has elapsed", () => {
      const lastRun = localDate(2025, 0, 15, 12, 0, 0);
      const now = localDate(2025, 0, 15, 12, 5, 0);
      expect(shouldRun("5m", lastRun, now)).toBe(true);
    });

    it("does not run when interval has not elapsed", () => {
      const lastRun = localDate(2025, 0, 15, 12, 0, 0);
      const now = localDate(2025, 0, 15, 12, 4, 59);
      expect(shouldRun("5m", lastRun, now)).toBe(false);
    });

    it("runs exactly at interval boundary", () => {
      const lastRun = localDate(2025, 0, 15, 12, 0, 0);
      const now = localDate(2025, 0, 15, 12, 5, 0);
      expect(shouldRun("5m", lastRun, now)).toBe(true);
    });

    it("handles hour intervals", () => {
      const lastRun = localDate(2025, 0, 15, 10, 0, 0);
      const now = localDate(2025, 0, 15, 11, 0, 0);
      expect(shouldRun("1h", lastRun, now)).toBe(true);
    });

    it("does not run for hour interval when not elapsed", () => {
      const lastRun = localDate(2025, 0, 15, 10, 0, 0);
      const now = localDate(2025, 0, 15, 10, 59, 59);
      expect(shouldRun("1h", lastRun, now)).toBe(false);
    });
  });

  describe("invalid schedule", () => {
    it("returns false for unrecognized schedule format", () => {
      const now = new Date();
      expect(shouldRun("invalid", null, now)).toBe(false);
      expect(shouldRun("", null, now)).toBe(false);
    });
  });
});

describe("cronジョブの configOverride", () => {
  afterEach(() => {
    vi.doUnmock("../config/config.js");
    vi.doUnmock("../discord/client.js");
    vi.doUnmock("../queue/inbox.js");
    vi.resetModules();
  });

  async function importRunnerWithMocks(rawCron: unknown[] = []) {
    const appendInboxMock = vi.fn().mockResolvedValue(undefined);
    vi.resetModules();
    vi.doMock("../config/config.js", () => ({
      loadRawCron: vi.fn().mockResolvedValue(rawCron),
    }));
    vi.doMock("../discord/client.js", () => ({ client: {} }));
    vi.doMock("../queue/inbox.js", () => ({ appendInbox: appendInboxMock }));
    const mod = await import("./runner.js");
    return { mod, appendInboxMock };
  }

  it("model/tools/skills 付きジョブをスキーマで受理する", async () => {
    const raw = [
      {
        id: "cheap-summary",
        schedule: "0 9 * * *",
        enabled: true,
        groupName: "g",
        prompt: "summarize",
        channelId: "ch",
        deliveryMode: "direct",
        sessionMode: "per-run",
        model: { provider: "zai", modelId: "glm-4.7-flash" },
        tools: ["read"],
        skills: ["session-logs"],
      },
    ];
    const { mod } = await importRunnerWithMocks(raw);

    await expect(mod.loadAndValidateCron()).resolves.toEqual([
      expect.objectContaining({
        id: "cheap-summary",
        model: { provider: "zai", modelId: "glm-4.7-flash" },
        tools: ["read"],
        skills: ["session-logs"],
      }),
    ]);
  });

  it('skills: "*" 付きジョブをスキーマで受理する', async () => {
    const raw = [
      {
        id: "all-skills-summary",
        schedule: "0 9 * * *",
        enabled: true,
        groupName: "g",
        prompt: "summarize",
        channelId: "ch",
        deliveryMode: "direct",
        sessionMode: "per-run",
        skills: "*",
      },
    ];
    const { mod } = await importRunnerWithMocks(raw);

    await expect(mod.loadAndValidateCron()).resolves.toEqual([
      expect.objectContaining({
        id: "all-skills-summary",
        skills: "*",
      }),
    ]);
  });

  it("executeJob は上書きがあると appendInbox に configOverride を渡す", async () => {
    const { mod, appendInboxMock } = await importRunnerWithMocks();

    await mod.executeJob({
      id: "cheap-summary",
      schedule: "0 9 * * *",
      enabled: true,
      groupName: "g",
      prompt: "summarize",
      channelId: "ch",
      deliveryMode: "direct",
      sessionMode: "per-run",
      model: { provider: "zai", modelId: "glm-4.7-flash" },
      tools: ["read"],
      skills: ["session-logs"],
    });

    expect(appendInboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "ch",
        groupName: "g",
        content: "summarize",
        cronJobId: "cheap-summary",
        configOverride: {
          model: { provider: "zai", modelId: "glm-4.7-flash" },
          tools: ["read"],
          skills: ["session-logs"],
        },
      }),
    );
  });

  it("executeJob は new-thread でも configOverride を渡す", async () => {
    const { mod, appendInboxMock } = await importRunnerWithMocks();

    await mod.executeJob({
      id: "thread-summary",
      schedule: "0 9 * * *",
      enabled: true,
      groupName: "g",
      prompt: "summarize",
      channelId: "ch",
      deliveryMode: "new-thread",
      sessionMode: "destination",
      tools: ["read"],
    });

    expect(appendInboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cronDeliveryMode: "new-thread",
        cronSessionMode: "destination",
        cronJobId: "thread-summary",
        configOverride: { tools: ["read"] },
      }),
    );
  });

  it("executeJob は上書きが無ければ configOverride を含めない", async () => {
    const { mod, appendInboxMock } = await importRunnerWithMocks();

    await mod.executeJob({
      id: "plain",
      schedule: "0 9 * * *",
      enabled: true,
      groupName: "g",
      prompt: "hello",
      channelId: "ch",
      deliveryMode: "direct",
      sessionMode: "per-run",
    });

    expect(appendInboxMock).toHaveBeenCalledOnce();
    expect(appendInboxMock.mock.calls[0][0]).not.toHaveProperty(
      "configOverride",
    );
  });
});
