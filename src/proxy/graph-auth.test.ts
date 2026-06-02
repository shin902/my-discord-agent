import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MSAL_CONFIG = {
  tenantId: "consumers",
  clientId: "test-client-id",
  scopes: ["https://graph.microsoft.com/Mail.Read"],
};

function makePca(overrides: {
  getAllAccounts?: ReturnType<typeof vi.fn>;
  acquireTokenSilent?: ReturnType<typeof vi.fn>;
  acquireTokenByDeviceCode?: ReturnType<typeof vi.fn>;
  removeAccount?: ReturnType<typeof vi.fn>;
  serialize?: ReturnType<typeof vi.fn>;
} = {}) {
  const getAllAccounts =
    overrides.getAllAccounts ?? vi.fn().mockResolvedValue([]);
  const acquireTokenSilent =
    overrides.acquireTokenSilent ??
    vi.fn().mockRejectedValue(new Error("no token"));
  const acquireTokenByDeviceCode =
    overrides.acquireTokenByDeviceCode ?? vi.fn().mockResolvedValue(null);
  const removeAccount =
    overrides.removeAccount ?? vi.fn().mockResolvedValue(undefined);
  const serialize =
    overrides.serialize ?? vi.fn().mockReturnValue('{"accounts":{}}');

  return {
    acquireTokenSilent,
    acquireTokenByDeviceCode,
    getTokenCache: vi.fn().mockReturnValue({
      getAllAccounts,
      serialize,
      deserialize: vi.fn(),
      removeAccount,
    }),
    _mocks: { getAllAccounts, acquireTokenSilent, acquireTokenByDeviceCode, removeAccount, serialize },
  };
}

describe("getGraphAccessToken", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("initGraphAuth を呼ばずに呼び出すとエラーを投げる", async () => {
    vi.doMock("@azure/msal-node", () => ({
      PublicClientApplication: vi.fn(),
    }));
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    }));
    const { getGraphAccessToken } = await import("./graph-auth.js");
    await expect(getGraphAccessToken("graph")).rejects.toThrow(
      "Graph Auth が初期化されていません",
    );
  });

  it("サイレント取得成功 → トークンを返しキャッシュを永続化する", async () => {
    const fakeAccount = { homeAccountId: "acc-1" };
    const pca = makePca({
      getAllAccounts: vi.fn().mockResolvedValue([fakeAccount]),
      acquireTokenSilent: vi.fn().mockResolvedValue({ accessToken: "silent-token" }),
    });
    const writeFile = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@azure/msal-node", () => ({
      PublicClientApplication: function () { return pca; },
    }));
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile,
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const { initGraphAuth, getGraphAccessToken } = await import("./graph-auth.js");
    await initGraphAuth("graph", MSAL_CONFIG);
    const token = await getGraphAccessToken("graph");

    expect(token).toBe("silent-token");
    expect(pca._mocks.acquireTokenSilent).toHaveBeenCalledWith(
      expect.objectContaining({ account: fakeAccount, scopes: MSAL_CONFIG.scopes }),
    );
    expect(writeFile).toHaveBeenCalled();
  });

  it("サイレント取得がすべて失敗 → デバイスコードフローにフォールバックする", async () => {
    const fakeAccount = { homeAccountId: "acc-1" };
    const pca = makePca({
      getAllAccounts: vi.fn().mockResolvedValue([fakeAccount]),
      acquireTokenSilent: vi.fn().mockRejectedValue(new Error("expired")),
      acquireTokenByDeviceCode: vi
        .fn()
        .mockResolvedValue({ accessToken: "device-token" }),
    });

    vi.doMock("@azure/msal-node", () => ({
      PublicClientApplication: function () { return pca; },
    }));
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const { initGraphAuth, getGraphAccessToken } = await import("./graph-auth.js");
    await initGraphAuth("graph", MSAL_CONFIG);
    const token = await getGraphAccessToken("graph");

    expect(token).toBe("device-token");
    expect(pca._mocks.acquireTokenByDeviceCode).toHaveBeenCalled();
    expect(pca._mocks.removeAccount).toHaveBeenCalledWith(fakeAccount);
  });

  it("複数アカウントのうち最初の1つが成功すれば残りを試みない", async () => {
    const acc1 = { homeAccountId: "acc-1" };
    const acc2 = { homeAccountId: "acc-2" };
    const acquireTokenSilent = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "token-acc1" })
      .mockRejectedValue(new Error("should not reach"));
    const pca = makePca({
      getAllAccounts: vi.fn().mockResolvedValue([acc1, acc2]),
      acquireTokenSilent,
    });

    vi.doMock("@azure/msal-node", () => ({
      PublicClientApplication: function () { return pca; },
    }));
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));

    const { initGraphAuth, getGraphAccessToken } = await import("./graph-auth.js");
    await initGraphAuth("graph", MSAL_CONFIG);
    const token = await getGraphAccessToken("graph");

    expect(token).toBe("token-acc1");
    expect(acquireTokenSilent).toHaveBeenCalledTimes(1);
  });

  it("デバイスコードフローが null を返すとエラーを投げる", async () => {
    const pca = makePca({
      acquireTokenByDeviceCode: vi.fn().mockResolvedValue(null),
    });

    vi.doMock("@azure/msal-node", () => ({
      PublicClientApplication: function () { return pca; },
    }));
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    }));

    const { initGraphAuth, getGraphAccessToken } = await import("./graph-auth.js");
    await initGraphAuth("graph", MSAL_CONFIG);
    await expect(getGraphAccessToken("graph")).rejects.toThrow(
      "デバイスコードフローでトークンを取得できませんでした",
    );
  });
});
