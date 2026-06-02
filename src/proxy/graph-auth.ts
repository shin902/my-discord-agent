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
  pca: PublicClientApplication;
  config: MsalConfig;
  cachePath: string;
};

const registry = new Map<string, ProviderState>();

function cachePathFor(provider: string): string {
  return path.join(DATA_DIR, `graph-token-${provider}.json`);
}

async function loadCacheFromFile(cachePath: string): Promise<string | null> {
  try {
    return await readFile(cachePath, "utf-8");
  } catch {
    return null;
  }
}

async function persistCache(state: ProviderState): Promise<void> {
  const serialized = state.pca.getTokenCache().serialize();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(state.cachePath, serialized, { encoding: "utf-8", mode: 0o600 });
  await chmod(state.cachePath, 0o600);
}

export async function initGraphAuth(
  provider: string,
  config: MsalConfig,
): Promise<void> {
  const cachePath = cachePathFor(provider);
  const cachedData = await loadCacheFromFile(cachePath);

  const pca = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
    },
  });

  if (cachedData) {
    pca.getTokenCache().deserialize(cachedData);
  }

  registry.set(provider, { pca, config, cachePath });
}

export async function getGraphAccessToken(provider: string): Promise<string> {
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
      await persistCache(state);
      return result.accessToken;
    } catch {
      // このアカウントのサイレント取得失敗、次を試みる
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

  await persistCache(state);
  return result.accessToken;
}
