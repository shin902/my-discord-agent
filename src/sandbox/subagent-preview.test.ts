import { describe, expect, it } from "vitest";
import { resultPreview, taskPreview } from "./subagent-preview.js";

describe("subagent previews", () => {
  it("uses the approved task and result limits", () => {
    expect(taskPreview("x".repeat(200)).length).toBeLessThanOrEqual(120);
    expect(resultPreview("x".repeat(300)).length).toBeLessThanOrEqual(200);
    expect(taskPreview("   ")).toBe("(empty task)");
    expect(resultPreview("\n")).toBe("(empty result)");
  });
});
