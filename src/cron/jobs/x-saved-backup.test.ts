import { beforeEach, describe, expect, it, vi } from "vitest";

const backupXSavedDatabase = vi.hoisted(() => vi.fn());
vi.mock("../../integrations/x-saved/store.js", () => ({
  backupXSavedDatabase,
}));

import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";
import handler from "./x-saved-backup.js";

function makeContext(settings?: unknown): CronContext {
  return {
    id: "x-saved-backup",
    schedule: "0 5 * * *",
    enabled: false,
    handler: "jobs/x-saved-backup.ts",
    client: {} as never,
    appendInbox: vi.fn(),
    settings,
  };
}

describe("x-saved-backup cron", () => {
  beforeEach(() => {
    backupXSavedDatabase.mockReset();
    backupXSavedDatabase.mockResolvedValue("/backups/x-saved.sqlite");
  });

  it("uses the store defaults when no retention setting is provided", async () => {
    await handler(makeContext());

    expect(backupXSavedDatabase).toHaveBeenCalledOnce();
    expect(backupXSavedDatabase).toHaveBeenCalledWith();
  });

  it("passes the configured retention count and leaves paths to the store defaults", async () => {
    await handler(makeContext({ keep: 30 }));

    expect(backupXSavedDatabase).toHaveBeenCalledWith(undefined, 30);
  });

  it("rejects unknown or invalid settings as non-retryable errors", async () => {
    await expect(
      handler(makeContext({ path: "/tmp/backup" })),
    ).rejects.toBeInstanceOf(NonRetryableError);
    await expect(handler(makeContext({ keep: 0 }))).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(backupXSavedDatabase).not.toHaveBeenCalled();
  });

  it("propagates backup failures for cron retry", async () => {
    const error = new Error("database unavailable");
    backupXSavedDatabase.mockRejectedValue(error);

    await expect(handler(makeContext())).rejects.toBe(error);
  });
});
