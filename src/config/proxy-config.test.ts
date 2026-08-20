import { describe, expect, it, vi } from "vitest";
import {
  loadRequestTimeoutMs,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "./proxy-config.js";
import type { JsonValue } from "./config.js";
type Config = Record<string, JsonValue>;
const config = (value: Config): Promise<Config> => Promise.resolve(value);

describe("loadRequestTimeoutMs", () => {
  it("デフォルトは 120000", async () =>
    expect(await loadRequestTimeoutMs(() => config({}))).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    ));
  it("設定ファイルの requestTimeoutMs が読み込まれる", async () =>
    expect(
      await loadRequestTimeoutMs(() =>
        config({ proxy: { requestTimeoutMs: 60_000 } }),
      ),
    ).toBe(60_000));
  it("設定ファイルに proxy キーがない場合はデフォルト値を返す", async () =>
    expect(await loadRequestTimeoutMs(() => config({ someOtherKey: {} }))).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    ));
  it("設定ファイルの requestTimeoutMs が欠落していてもデフォルトを返す", async () =>
    expect(await loadRequestTimeoutMs(() => config({ proxy: {} }))).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    ));
  it("requestTimeoutMs が不正な値（文字列）は warn してデフォルトを返す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await loadRequestTimeoutMs(() =>
        config({ proxy: { requestTimeoutMs: "60000" } }),
      ),
    ).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("requestTimeoutMs が 0 以下は不正として warn しデフォルトを返す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await loadRequestTimeoutMs(() =>
        config({ proxy: { requestTimeoutMs: 0 } }),
      ),
    ).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    warn.mockRestore();
  });
});
