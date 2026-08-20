import { describe, expect, it } from "vitest";
import type { JsonValue } from "./config.js";
import { loadProviders, resolveProviderConcurrency } from "./providers.js";

type ProviderEntry = { provider: string; concurrency: "serial" | "parallel" };
const source =
  (entries: JsonValue[]): (() => Promise<JsonValue>) =>
  () =>
    Promise.resolve(entries);

describe("provider concurrency config", () => {
  it("serial / parallel を読み込む", async () =>
    expect(
      loadProviders(
        source([
          { provider: "zai", concurrency: "serial" },
          { provider: "codex-oauth", concurrency: "parallel" },
        ]),
      ),
    ).resolves.toEqual([
      { provider: "zai", concurrency: "serial" },
      { provider: "codex-oauth", concurrency: "parallel" },
    ]));
  it("同一 import でも毎回最新の concurrency を読み込む", async () => {
    const entries: ProviderEntry[][] = [
      [{ provider: "zai", concurrency: "serial" }],
      [{ provider: "zai", concurrency: "parallel" }],
    ];
    let index = 0;
    const loader = () => Promise.resolve(entries[index++]);
    await expect(loadProviders(loader)).resolves.toEqual(entries[0]);
    await expect(loadProviders(loader)).resolves.toEqual(entries[1]);
  });
  it("未設定 provider は安全側の serial にする", async () =>
    expect(resolveProviderConcurrency("zai", source([]))).resolves.toBe(
      "serial",
    ));
  it("設定済み provider の parallel を返す", async () =>
    expect(
      resolveProviderConcurrency(
        "codex-oauth",
        source([{ provider: "codex-oauth", concurrency: "parallel" }]),
      ),
    ).resolves.toBe("parallel"));
  it("不正な concurrency を拒否する", async () =>
    expect(
      loadProviders(source([{ provider: "zai", concurrency: "sometimes" }])),
    ).rejects.toThrow());
  it("provider の重複を拒否する", async () =>
    expect(
      loadProviders(
        source([
          { provider: "zai", concurrency: "serial" },
          { provider: "zai", concurrency: "parallel" },
        ]),
      ),
    ).rejects.toThrow(/重複/));
});
