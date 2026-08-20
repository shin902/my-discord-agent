import { describe, expect, it, vi } from "vitest";
import { loadAgentTimeoutMs, DEFAULT_AGENT_TIMEOUT_MS } from "./agent-config.js";
import type { JsonValue } from "./config.js";

type Config = Record<string, JsonValue>;
const config = (value: Config): Promise<Config> => Promise.resolve(value);

describe("loadAgentTimeoutMs", () => {
  it("デフォルトは 600000（10分）", async () => expect(await loadAgentTimeoutMs(() => config({}))).toBe(DEFAULT_AGENT_TIMEOUT_MS));
  it("設定ファイルの timeoutMs が読み込まれる", async () => expect(await loadAgentTimeoutMs(() => config({ agent: { timeoutMs: 300_000 } }))).toBe(300_000));
  it("設定ファイルに agent キーがない場合はデフォルト値を返す", async () => expect(await loadAgentTimeoutMs(() => config({ someOtherKey: {} }))).toBe(DEFAULT_AGENT_TIMEOUT_MS));
  it("設定ファイルの timeoutMs が欠落していてもデフォルトを返す", async () => expect(await loadAgentTimeoutMs(() => config({ agent: {} }))).toBe(DEFAULT_AGENT_TIMEOUT_MS));
  it("timeoutMs が不正な値（文字列）は warn してデフォルトを返す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadAgentTimeoutMs(() => config({ agent: { timeoutMs: "300000" } }))).toBe(DEFAULT_AGENT_TIMEOUT_MS);
    expect(warn).toHaveBeenCalled(); warn.mockRestore();
  });
  it("timeoutMs が 0 以下は不正として warn しデフォルトを返す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadAgentTimeoutMs(() => config({ agent: { timeoutMs: 0 } }))).toBe(DEFAULT_AGENT_TIMEOUT_MS); warn.mockRestore();
  });
});
