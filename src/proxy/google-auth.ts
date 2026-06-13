import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GoogleOAuthConfig } from "../config/credential-proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "../../data");

const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

// アクセストークンの有効期限直前での失効を避けるための安全マージン
const EXPIRY_MARGIN_MS = 60_000;

type ProviderState = {
  config: GoogleOAuthConfig;
  clientSecret: string;
  cachePath: string;
};

type CachedTokens = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

const registry = new Map<string, ProviderState>();

function cachePathFor(provider: string): string {
  return path.join(DATA_DIR, `google-token-${provider}.json`);
}

async function loadCache(cachePath: string): Promise<CachedTokens> {
  try {
    const raw = await readFile(cachePath, "utf-8");
    return JSON.parse(raw) as CachedTokens;
  } catch {
    return {};
  }
}

async function persistCache(
  cachePath: string,
  tokens: CachedTokens,
): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(cachePath, JSON.stringify(tokens), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmod(cachePath, 0o600);
}

async function postForm(
  url: string,
  params: Record<string, string>,
): Promise<TokenResponse | DeviceCodeResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return (await res.json()) as TokenResponse | DeviceCodeResponse;
}

async function refreshAccessToken(
  state: ProviderState,
  refreshToken: string,
): Promise<TokenResponse> {
  return (await postForm(TOKEN_URL, {
    client_id: state.config.clientId,
    client_secret: state.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  })) as TokenResponse;
}

async function runDeviceCodeFlow(
  provider: string,
  state: ProviderState,
): Promise<TokenResponse> {
  const deviceCode = (await postForm(DEVICE_CODE_URL, {
    client_id: state.config.clientId,
    scope: state.config.scopes.join(" "),
  })) as DeviceCodeResponse;

  console.log(`\n[google-auth:${provider}] 認証が必要です`);
  console.log(
    `[google-auth:${provider}] ${deviceCode.verification_url} を開き、コード ${deviceCode.user_code} を入力してください`,
  );

  const intervalMs = (deviceCode.interval ?? 5) * 1000;
  const deadline = Date.now() + deviceCode.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const result = (await postForm(TOKEN_URL, {
      client_id: state.config.clientId,
      client_secret: state.clientSecret,
      device_code: deviceCode.device_code,
      grant_type: DEVICE_GRANT_TYPE,
    })) as TokenResponse;

    if (result.access_token) return result;
    if (result.error && result.error !== "authorization_pending") {
      if (result.error === "slow_down") continue;
      throw new Error(
        `Google OAuth デバイスフローが失敗しました: ${result.error} ${result.error_description ?? ""}`,
      );
    }
  }

  throw new Error(
    `Google OAuth デバイスフローがタイムアウトしました (provider: ${provider})`,
  );
}

export async function initGoogleAuth(
  provider: string,
  config: GoogleOAuthConfig,
  clientSecret: string,
): Promise<void> {
  registry.set(provider, {
    config,
    clientSecret,
    cachePath: cachePathFor(provider),
  });
}

export async function getGoogleAccessToken(provider: string): Promise<string> {
  const state = registry.get(provider);
  if (!state) {
    throw new Error(
      `Google Auth が初期化されていません (provider: ${provider})。initGoogleAuth() を先に呼んでください`,
    );
  }

  const cached = await loadCache(state.cachePath);

  if (
    cached.accessToken &&
    cached.expiresAt &&
    cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()
  ) {
    return cached.accessToken;
  }

  if (cached.refreshToken) {
    const refreshed = await refreshAccessToken(state, cached.refreshToken);
    if (refreshed.access_token) {
      const tokens: CachedTokens = {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? cached.refreshToken,
        expiresAt: Date.now() + (refreshed.expires_in ?? 0) * 1000,
      };
      await persistCache(state.cachePath, tokens);
      return tokens.accessToken as string;
    }
    console.warn(
      `[google-auth:${provider}] リフレッシュトークンでの取得に失敗しました。デバイスコードフローにフォールバックします`,
    );
  }

  const result = await runDeviceCodeFlow(provider, state);
  if (!result.access_token) {
    throw new Error(
      `デバイスコードフローでトークンを取得できませんでした (provider: ${provider})`,
    );
  }

  const tokens: CachedTokens = {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? cached.refreshToken,
    expiresAt: Date.now() + (result.expires_in ?? 0) * 1000,
  };
  await persistCache(state.cachePath, tokens);
  return tokens.accessToken as string;
}
