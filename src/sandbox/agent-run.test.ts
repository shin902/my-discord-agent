import { describe, expect, it } from "vitest";
import { AgentRunRegistry } from "./agent-run.js";

describe("AgentRunRegistry", () => {
  it("creates subagent runs with required parent and task metadata", () => {
    const registry = new AgentRunRegistry();
    const parent = registry.create({ kind: "root" });

    const child = registry.create({
      kind: "subagent",
      parentRunId: parent.id,
      taskPreview: "inspect independently",
    });

    expect(child).toMatchObject({
      kind: "subagent",
      parentRunId: parent.id,
      taskPreview: "inspect independently",
      status: "running",
    });
  });

  it("retains only the newest completed runs", () => {
    const registry = new AgentRunRegistry(2);
    const first = registry.create({ kind: "root" });
    const second = registry.create({ kind: "root" });
    const third = registry.create({ kind: "root" });

    registry.complete(first.id);
    registry.complete(second.id);
    registry.complete(third.id);

    expect(registry.get(first.id)).toBeUndefined();
    expect(registry.get(second.id)).toBeDefined();
    expect(registry.get(third.id)).toBeDefined();
    expect(registry.list()).toHaveLength(2);
  });

  it("does not evict active runs while retaining terminal runs", () => {
    const registry = new AgentRunRegistry(1);
    const active = registry.create({ kind: "root" });
    const completed = registry.create({ kind: "root" });
    registry.complete(completed.id);
    const nextCompleted = registry.create({ kind: "root" });
    registry.complete(nextCompleted.id);

    expect(registry.get(active.id)).toBeDefined();
    expect(registry.get(completed.id)).toBeUndefined();
    expect(registry.get(nextCompleted.id)).toBeDefined();
  });

  it("rejects an invalid retention limit", () => {
    expect(() => new AgentRunRegistry(-1)).toThrow("maxCompletedRuns");
    expect(() => new AgentRunRegistry(1.5)).toThrow("maxCompletedRuns");
  });
});
