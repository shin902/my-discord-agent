import { describe, expect, it } from "vitest";
import { webfetchTool } from "./webfetch.js";
import { resolveTools } from "./registry.js";

describe("resolveTools", () => {
  it("webfetch を解決して webfetchTool を返す", () => {
    expect(resolveTools(["webfetch"])).toEqual([webfetchTool]);
  });

  it("空配列は空配列を返す", () => {
    expect(resolveTools([])).toEqual([]);
  });

  it("不明なツール名はエラーをスローする", () => {
    expect(() => resolveTools(["invalid"])).toThrow("不明なツール名: invalid");
  });
});
