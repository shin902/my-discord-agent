import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const { readFile } = await import("node:fs/promises");

beforeEach(() => {
  vi.clearAllMocks();
});

async function importFresh() {
  vi.resetModules();
  const mod = await import("./credential-proxy.js");
  return mod as typeof import("./credential-proxy.js");
}

describe("loadCredentialProxy", () => {
  it("設定ファイルを読み込んでパースする", async () => {
    const { loadCredentialProxy } = await importFresh();
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify([
        { envVar: "API_KEY", baseUrl: "https://api.example.com" },
      ]),
    );

    const result = await loadCredentialProxy();
    expect(result).toEqual([
      { envVar: "API_KEY", baseUrl: "https://api.example.com" },
    ]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("2回目以降の呼び出しではキャッシュを返し readFile を呼ばない", async () => {
    const { loadCredentialProxy } = await importFresh();
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify([
        { envVar: "API_KEY", baseUrl: "https://api.example.com" },
      ]),
    );

    await loadCredentialProxy();
    const result = await loadCredentialProxy();
    expect(result).toEqual([
      { envVar: "API_KEY", baseUrl: "https://api.example.com" },
    ]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("ファイルが存在しない場合は空配列をキャッシュして返す", async () => {
    const { loadCredentialProxy } = await importFresh();
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const result1 = await loadCredentialProxy();
    expect(result1).toEqual([]);

    const result2 = await loadCredentialProxy();
    expect(result2).toEqual([]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("ENOENT 以外のエラーは再スロー", async () => {
    const { loadCredentialProxy } = await importFresh();
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );

    await expect(loadCredentialProxy()).rejects.toThrow("EACCES");
  });

  it("不正な JSON は SyntaxError を投げる", async () => {
    const { loadCredentialProxy } = await importFresh();
    vi.mocked(readFile).mockResolvedValue("{ invalid json }");

    await expect(loadCredentialProxy()).rejects.toThrow(SyntaxError);
  });

  it("スキーマに合わない JSON は ZodError を投げる", async () => {
    const { loadCredentialProxy } = await importFresh();
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify([{ envVar: "API_KEY", baseUrl: "not-a-url" }]),
    );

    await expect(loadCredentialProxy()).rejects.toThrow();
  });

  it("空配列も正常にキャッシュされる", async () => {
    const { loadCredentialProxy } = await importFresh();
    vi.mocked(readFile).mockResolvedValue("[]");

    const result1 = await loadCredentialProxy();
    expect(result1).toEqual([]);

    const result2 = await loadCredentialProxy();
    expect(result2).toEqual([]);
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
