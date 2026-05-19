import { describe, expect, it } from "vitest";
import { resolveTools } from "./registry.js";
import { urlFetchTool } from "./url-fetch.js";

describe("resolveTools", () => {
  it("url-fetch を解決して urlFetchTool を返す", () => {
    expect(resolveTools(["url-fetch"])).toEqual([urlFetchTool]);
  });

  it("空配列は空配列を返す", () => {
    expect(resolveTools([])).toEqual([]);
  });

  it("不明なツール名はエラーをスローする", () => {
    expect(() => resolveTools(["invalid"])).toThrow("不明なツール名: invalid");
  });
});
