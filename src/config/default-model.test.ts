import { describe, expect, it } from "vitest";
import { loadDefaultModel } from "./default-model.js";
import type { JsonValue } from "./config.js";

const config = (
  value: Record<string, JsonValue>,
): Promise<Record<string, JsonValue>> => Promise.resolve(value);

describe("loadDefaultModel", () => {
  it("defaultModel が未設定の場合はエラーになる", async () => {
    await expect(loadDefaultModel(() => config({}))).rejects.toThrow(
      "defaultModel",
    );
  });
  it("config.json の defaultModel を優先して返す", async () => {
    await expect(
      loadDefaultModel(() =>
        config({
          defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
        }),
      ),
    ).resolves.toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-6" });
  });
  it("defaultModel が不正な形式の場合はエラーになる", async () => {
    await expect(
      loadDefaultModel(() => config({ defaultModel: { provider: 1 } })),
    ).rejects.toThrow();
  });
});
