import { describe, expect, it } from "vitest";
import { agentReachTool } from "./agent-reach.js";
import { resolveTools } from "./registry.js";

describe("resolveTools", () => {
  it("agent-reach を解決して agentReachTool を返す", () => {
    expect(resolveTools(["agent-reach"])).toEqual([agentReachTool]);
  });

  it("空配列は空配列を返す", () => {
    expect(resolveTools([])).toEqual([]);
  });

  it("不明なツール名はエラーをスローする", () => {
    expect(() => resolveTools(["invalid"])).toThrow("不明なツール名: invalid");
  });
});
