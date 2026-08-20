import { describe, expect, it, vi } from "vitest";
import type { AccountInfo } from "@azure/msal-node";
import { createGraphAuth, type GraphAuthClient, type GraphAuthFileSystem } from "./graph-auth.js";

const config = { tenantId: "consumers", clientId: "client", scopes: ["Mail.Read"] };
const account = (id: string): AccountInfo => ({ homeAccountId: id, environment: "env", tenantId: "tenant", username: `${id}@example.com`, localAccountId: id, name: id });
function setup(accounts: AccountInfo[] = [], overrides: Partial<{ silent: GraphAuthClient["acquireTokenSilent"]; device: GraphAuthClient["acquireTokenByDeviceCode"] }> = {}) {
  const cache = { getAllAccounts: vi.fn().mockResolvedValue(accounts), serialize: vi.fn().mockReturnValue("serialized"), deserialize: vi.fn(), removeAccount: vi.fn().mockResolvedValue(undefined) };
  const client: GraphAuthClient = { getTokenCache: () => cache, acquireTokenSilent: overrides.silent ?? vi.fn().mockRejectedValue(new Error("expired")), acquireTokenByDeviceCode: overrides.device ?? vi.fn().mockResolvedValue(null) };
  const fs: GraphAuthFileSystem = { readFile: vi.fn().mockRejectedValue(new Error("ENOENT")), writeFile: vi.fn().mockResolvedValue(undefined), mkdir: vi.fn().mockResolvedValue(undefined), chmod: vi.fn().mockResolvedValue(undefined) };
  return { client, cache, fs, auth: createGraphAuth({ fileSystem: fs, createClient: () => client }) };
}

describe("getGraphAccessToken", () => {
  it("requires initialization", async () => { const { auth } = setup(); await expect(auth.getGraphAccessToken("graph")).rejects.toThrow("Graph Auth が初期化されていません"); });
  it("returns and persists a silently acquired token", async () => {
    const silent = vi.fn().mockResolvedValue({ accessToken: "silent" });
    const state = setup([account("one")], { silent });
    await state.auth.initGraphAuth("graph", config);
    await expect(state.auth.getGraphAccessToken("graph")).resolves.toBe("silent");
    expect(silent).toHaveBeenCalledWith(expect.objectContaining({ account: expect.objectContaining({ homeAccountId: "one" }), scopes: config.scopes }));
    expect(state.fs.writeFile).toHaveBeenCalled();
  });
  it("falls back to device code and removes old accounts", async () => {
    const device = vi.fn().mockResolvedValue({ accessToken: "device" });
    const state = setup([account("one")], { device });
    await state.auth.initGraphAuth("graph", config);
    await expect(state.auth.getGraphAccessToken("graph")).resolves.toBe("device");
    expect(device).toHaveBeenCalled();
    expect(state.cache.removeAccount).toHaveBeenCalledWith(expect.objectContaining({ homeAccountId: "one" }));
  });
  it("stops after the first successful account", async () => {
    const silent = vi.fn().mockResolvedValueOnce({ accessToken: "first" }).mockRejectedValue(new Error("unexpected"));
    const state = setup([account("one"), account("two")], { silent });
    await state.auth.initGraphAuth("graph", config);
    await expect(state.auth.getGraphAccessToken("graph")).resolves.toBe("first");
    expect(silent).toHaveBeenCalledTimes(1);
  });
  it("rejects when device flow returns no result", async () => {
    const state = setup();
    await state.auth.initGraphAuth("graph", config);
    await expect(state.auth.getGraphAccessToken("graph")).rejects.toThrow("デバイスコードフローでトークンを取得できませんでした");
  });
});
