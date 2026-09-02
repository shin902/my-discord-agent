import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeRunCount,
  clearActiveRunsForTests,
  registerActiveRun,
  steerActiveRun,
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
