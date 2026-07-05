import { describe, expect, it } from "vitest";
import { resolveTools } from "./registry.js";

describe("resolveTools", () => {
  it("空配列は空配列を返す", () => {
    expect(resolveTools([])).toEqual([]);
  });

  it("不明なツール名はエラーをスローする", () => {
    expect(() => resolveTools(["invalid"])).toThrow("不明なツール名: invalid");
  });
});
