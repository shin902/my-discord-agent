import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeRunCount,
  clearActiveRunsForTests,
  registerActiveRun,
  steerActiveRun,
  stopActiveRun,
} from "./active-run-registry.js";

afterEach(() => clearActiveRunsForTests());

describe("active run registry", () => {
  it("delivers steering to the exact group and session", async () => {
    const control = vi.fn().mockResolvedValue(true);
    const cleanup = registerActiveRun("group-a", "session-a", control);

    await expect(
      steerActiveRun("group-a", "session-a", "change direction"),
    ).resolves.toBe("accepted");
    expect(control).toHaveBeenCalledWith("change direction");
    await expect(
      steerActiveRun("group-a", "session-b", "wrong session"),
    ).resolves.toBe("unavailable");
    await expect(
      steerActiveRun("group-b", "session-a", "wrong group"),
    ).resolves.toBe("unavailable");
    cleanup();
  });

  it("reports rejected delivery without removing the active run", async () => {
    const cleanup = registerActiveRun(
      "group-a",
      "session-a",
      vi.fn().mockResolvedValue(false),
    );
    await expect(
      steerActiveRun("group-a", "session-a", "rejected"),
    ).resolves.toBe("rejected");
    expect(activeRunCount()).toBe(1);
    cleanup();
  });

  it("stops only the exact active group and session", async () => {
    const stop = vi.fn().mockResolvedValue({ status: "aborted" });
    const cleanup = registerActiveRun("group-a", "session-a", vi.fn(), stop);

    await expect(stopActiveRun("group-a", "session-a")).resolves.toEqual({
      status: "aborted",
    });
    await expect(
      stopActiveRun("group-b", "session-a"),
    ).resolves.toBeUndefined();
    await expect(
      stopActiveRun("group-a", "session-b"),
    ).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    cleanup();
  });

  it("coalesces concurrent stop requests", async () => {
    let resolveStop!: (result: { status: "aborted" }) => void;
    const stop = vi.fn(
      () =>
        new Promise<{ status: "aborted" }>((resolve) => {
          resolveStop = resolve;
        }),
    );
    const cleanup = registerActiveRun("group-a", "session-a", vi.fn(), stop);

    const first = stopActiveRun("group-a", "session-a");
    const second = stopActiveRun("group-a", "session-a");
    resolveStop({ status: "aborted" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: "aborted" },
      { status: "aborted" },
    ]);
    expect(stop).toHaveBeenCalledOnce();
    cleanup();
  });

  it("retries cleanup after a cleanup failure while coalescing in-flight stops", async () => {
    const stop = vi
      .fn()
      .mockResolvedValueOnce({ status: "cleanup-failure", error: "failed" })
      .mockResolvedValueOnce({ status: "aborted" });
    const cleanup = registerActiveRun("group-a", "session-a", vi.fn(), stop);

    await expect(stopActiveRun("group-a", "session-a")).resolves.toEqual({
      status: "cleanup-failure",
      error: "failed",
    });
    await expect(stopActiveRun("group-a", "session-a")).resolves.toEqual({
      status: "aborted",
    });
    expect(stop).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("rejects steering without an active run and cleans up", async () => {
    await expect(
      steerActiveRun("group-a", "session-a", "no target"),
    ).resolves.toBe("unavailable");
    const cleanup = registerActiveRun("group-a", "session-a", vi.fn());
    expect(activeRunCount()).toBe(1);
    cleanup();
    expect(activeRunCount()).toBe(0);
    await expect(
      steerActiveRun("group-a", "session-a", "after cleanup"),
    ).resolves.toBe("unavailable");
  });
});
