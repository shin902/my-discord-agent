import { describe, expect, it } from "vitest";
import {
  resultPreview,
  sanitizeSubagentPreview,
  taskPreview,
} from "./subagent-preview.js";

describe("subagent previews", () => {
  it("normalizes newlines, neutralizes Discord mentions, and truncates", () => {
    const preview = sanitizeSubagentPreview(
      `first\r\nsecond @everyone <@123>\n${"x".repeat(200)}`,
      20,
    );

    expect(preview).not.toContain("\n");
    expect(preview).not.toContain("@everyone");
    expect(preview).not.toContain("<@123>");
    expect(preview.length).toBeLessThanOrEqual(20);
  });

  it("uses the approved task and result limits", () => {
    expect(taskPreview("x".repeat(200)).length).toBeLessThanOrEqual(120);
    expect(resultPreview("x".repeat(300)).length).toBeLessThanOrEqual(200);
    expect(taskPreview("   ")).toBe("(empty task)");
    expect(resultPreview("\n")).toBe("(empty result)");
  });
});
