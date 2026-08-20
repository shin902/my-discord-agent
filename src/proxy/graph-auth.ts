import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AuthenticationResult,
  type DeviceCodeRequest,
  PublicClientApplication,
  type SilentFlowRequest,
} from "@azure/msal-node";
import type { MsalConfig } from "../config/credential-proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../../data");

type ProviderState = {
  pca: GraphAuthClient;
  config: MsalConfig;
  cachePath: string;
};

function cachePathFor(provider: string): string {
  return path.join(DATA_DIR, `graph-token-${provider}.json`);
}

async function loadCacheFromFile(fileSystem: GraphAuthFileSystem, cachePath: string): Promise<string | null> {
  try {
    return await fileSystem.readFile(cachePath, "utf-8");
  } catch {
    return null;
  }
}

async function persistCache(fileSystem: GraphAuthFileSystem, state: ProviderState): Promise<void> {
  const serialized = state.pca.getTokenCache().serialize();
  await fileSystem.mkdir(DATA_DIR, { recursive: true });
  await fileSystem.writeFile(state.cachePath, serialized, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fileSystem.chmod(state.cachePath, 0o600);
}

export type GraphAuthFileSystem = {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  mkdir: typeof mkdir;
  chmod: typeof chmod;
};

type GraphTokenCache = Pick<ReturnType<PublicClientApplication["getTokenCache"]>, "getAllAccounts" | "serialize" | "deserialize" | "removeAccount">;
export type GraphAuthClient = Pick<PublicClientApplication, "acquireTokenSilent" | "acquireTokenByDeviceCode"> & {
  getTokenCache: () => GraphTokenCache;
};
export type GraphAuthDependencies = {
  fileSystem?: GraphAuthFileSystem;
  createClient?: (config: MsalConfig) => GraphAuthClient;
};

export function createGraphAuth(dependencies: GraphAuthDependencies = {}) {
  const fileSystem = dependencies.fileSystem ?? { readFile, writeFile, mkdir, chmod };
  const createClient = dependencies.createClient ?? ((config) => new PublicClientApplication({
    auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}` },
  }));
  const registry = new Map<string, ProviderState>();

  async function initGraphAuth(
    provider: string,
    config: MsalConfig,
  ): Promise<void> {
  const cachePath = cachePathFor(provider);
  const cachedData = await loadCacheFromFile(fileSystem, cachePath);

  const pca = createClient(config);

  if (cachedData) {
    pca.getTokenCache().deserialize(cachedData);
  }

  registry.set(provider, { pca, config, cachePath });
}

  async function getGraphAccessToken(provider: string): Promise<string> {
  const state = registry.get(provider);
  if (!state) {
    throw new Error(
      `Graph Auth が初期化されていません (provider: ${provider})。initGraphAuth() を先に呼んでください`,
    );
  }

  const { pca, config } = state;
  const accounts = await pca.getTokenCache().getAllAccounts();

  for (const account of accounts) {
    try {
      const silentRequest: SilentFlowRequest = {
        account,
        scopes: config.scopes,
      };
      const result: AuthenticationResult =
        await pca.acquireTokenSilent(silentRequest);
      await persistCache(fileSystem, state);
      return result.accessToken;
    } catch (err) {
      console.warn(
        `[graph-auth:${provider}] silent token acquisition failed for ${account.username}:`,
        err,
      );
    }
  }

  if (accounts.length > 0) {
    console.warn(
      `[graph-auth:${provider}] ${accounts.length} 件のキャッシュ済みアカウントがすべてサイレント取得に失敗しました。デバイスコードフローにフォールバックします`,
    );
  }

  const deviceCodeRequest: DeviceCodeRequest = {
    scopes: config.scopes,
    deviceCodeCallback: (response) => {
      console.log(`\n[graph-auth:${provider}] 認証が必要です`);
      console.log(`[graph-auth:${provider}] ${response.message}`);
    },
  };

  const result = await pca.acquireTokenByDeviceCode(deviceCodeRequest);
  if (!result)
    throw new Error(
      `デバイスコードフローでトークンを取得できませんでした (provider: ${provider})`,
    );

  // 再認証後は古いアカウントを削除してキャッシュを1アカウントに保つ
  for (const oldAccount of accounts) {
    await pca.getTokenCache().removeAccount(oldAccount);
  }

    await persistCache(fileSystem, state);
    return result.accessToken;
  }

  return { initGraphAuth, getGraphAccessToken };
}

const defaultAuth = createGraphAuth();
export const initGraphAuth = defaultAuth.initGraphAuth;
export const getGraphAccessToken = defaultAuth.getGraphAccessToken;
