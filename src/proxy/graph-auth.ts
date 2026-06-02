import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const TOKEN_CACHE_PATH = path.join(__dirname, "../../data/graph-token.json");

let pca: PublicClientApplication | null = null;
let msalConfig: MsalConfig | null = null;

async function loadCacheFromFile(): Promise<string | null> {
  try {
    return await readFile(TOKEN_CACHE_PATH, "utf-8");
  } catch {
    return null;
  }
}

async function saveCacheToFile(serialized: string): Promise<void> {
  await mkdir(path.dirname(TOKEN_CACHE_PATH), { recursive: true });
  await writeFile(TOKEN_CACHE_PATH, serialized, "utf-8");
}

export async function initGraphAuth(config: MsalConfig): Promise<void> {
  msalConfig = config;

  const cachedData = await loadCacheFromFile();

  pca = new PublicClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
    },
  });

  if (cachedData) {
    pca.getTokenCache().deserialize(cachedData);
  }
}

async function persistCache(): Promise<void> {
  if (!pca) return;
  const serialized = pca.getTokenCache().serialize();
  await saveCacheToFile(serialized);
}

export async function getGraphAccessToken(): Promise<string> {
  if (!pca || !msalConfig) {
    throw new Error(
      "Graph Auth が初期化されていません。initGraphAuth() を先に呼んでください",
    );
  }

  const accounts = await pca.getTokenCache().getAllAccounts();

  if (accounts.length > 0) {
    const silentRequest: SilentFlowRequest = {
      account: accounts[0],
      scopes: msalConfig.scopes,
    };

    try {
      const result: AuthenticationResult =
        await pca.acquireTokenSilent(silentRequest);
      await persistCache();
      return result.accessToken;
    } catch {
      // サイレント取得失敗 → デバイスコードフローで再認証
    }
  }

  const deviceCodeRequest: DeviceCodeRequest = {
    scopes: msalConfig.scopes,
    deviceCodeCallback: (response) => {
      console.log("\n[graph-auth] Outlook 認証が必要です");
      console.log(`[graph-auth] ${response.message}`);
    },
  };

  const result = await pca.acquireTokenByDeviceCode(deviceCodeRequest);
  if (!result)
    throw new Error("デバイスコードフローでトークンを取得できませんでした");
  await persistCache();
  return result.accessToken;
}
