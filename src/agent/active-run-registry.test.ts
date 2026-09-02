import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeRunCount,
  clearActiveRunsForTests,
  registerActiveRun,
  steerActiveRun,
} from "./active-run-registry.js";

afterEach(() => clearActiveRunsForTests());

describe("active run registry", () => {
  it("delivers steering to the exact group and session", () => {
    const control = vi.fn();
    const cleanup = registerActiveRun("group-a", "session-a", control);

    expect(steerActiveRun("group-a", "session-a", "change direction")).toBe(
      true,
    );
    expect(control).toHaveBeenCalledWith("change direction");
    expect(steerActiveRun("group-a", "session-b", "wrong session")).toBe(false);
    expect(steerActiveRun("group-b", "session-a", "wrong group")).toBe(false);
    cleanup();
  });

  it("rejects steering without an active run and cleans up", () => {
    expect(steerActiveRun("group-a", "session-a", "no target")).toBe(false);
    const cleanup = registerActiveRun("group-a", "session-a", vi.fn());
    expect(activeRunCount()).toBe(1);
    cleanup();
    expect(activeRunCount()).toBe(0);
    expect(steerActiveRun("group-a", "session-a", "after cleanup")).toBe(false);
  });
});
