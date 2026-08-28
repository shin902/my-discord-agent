import { describe, expect, it } from "vitest";
import {
  completeAgentRun,
  createRootAgentRun,
  createSubagentRun,
  failAgentRun,
} from "./agent-run.js";

describe("agent run lifecycle", () => {
  it("creates child metadata from its parent run", () => {
    const parent = createRootAgentRun({ maxDelegationDepth: 2 });
    const child = createSubagentRun(parent, "inspect independently");

    expect(child).toMatchObject({
      kind: "subagent",
      parentRunId: parent.id,
      taskPreview: "inspect independently",
      status: "running",
      delegationDepth: 1,
      maxDelegationDepth: 2,
    });
  });

  it("preserves the parent's delegation settings for nested children", () => {
    const root = createRootAgentRun({ maxDelegationDepth: 3 });
    const child = createSubagentRun(root, "first task");
    const grandchild = createSubagentRun(child, "nested task");

    expect(grandchild).toMatchObject({
      parentRunId: child.id,
      delegationDepth: 2,
      maxDelegationDepth: 3,
    });
  });

  it("transitions run status without retaining completion history", () => {
    const completed = createRootAgentRun();
    const failed = createRootAgentRun();

    completeAgentRun(completed);
    failAgentRun(failed);

    expect(completed).toMatchObject({ status: "completed" });
    expect(completed).not.toHaveProperty("result");
    expect(completed).not.toHaveProperty("startedAt");
    expect(completed).not.toHaveProperty("completedAt");
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed).not.toHaveProperty("startedAt");
    expect(failed).not.toHaveProperty("completedAt");
  });

  it("defaults the maximum delegation depth to one", () => {
    expect(createRootAgentRun().maxDelegationDepth).toBe(1);
  });
});
