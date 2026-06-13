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

type PendingAuth = {
  verificationUrl: string;
  userCode: string;
};

type ProviderState = {
  config: GoogleOAuthConfig;
  clientSecret: string;
  cachePath: string;
  pendingAuth?: PendingAuth;
};

// ツール実行時にデバイス認証が未完了の場合に投げる。
// verificationUrl・userCode をエラーメッセージに含め、
// Discord 上のユーザーに認証手順を案内できるようにする。
export class GoogleAuthRequiredError extends Error {
  constructor(provider: string, pending: PendingAuth) {
    super(
      `Google Calendar の認証が必要です。${pending.verificationUrl} を開き、コード "${pending.userCode}" を入力して認証してください。認証完了後、しばらくしてから再度お試しください。(provider: ${provider})`,
    );
    this.name = "GoogleAuthRequiredError";
  }
}

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

// デバイスコードフローをバックグラウンドでポーリングし、完了したらトークンを
// キャッシュに保存する。getGoogleAccessToken はこの完了を待たずに
// GoogleAuthRequiredError を投げて即座に呼び出し元へ認証URLを返す。
async function pollDeviceCode(
  provider: string,
  state: ProviderState,
  deviceCode: DeviceCodeResponse,
): Promise<void> {
  const intervalMs = (deviceCode.interval ?? 5) * 1000;
  const deadline = Date.now() + deviceCode.expires_in * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    let result: TokenResponse;
    try {
      result = (await postForm(TOKEN_URL, {
        client_id: state.config.clientId,
        client_secret: state.clientSecret,
        device_code: deviceCode.device_code,
        grant_type: DEVICE_GRANT_TYPE,
      })) as TokenResponse;
    } catch (err) {
      console.error(
        `[google-auth:${provider}] トークン取得中にエラーが発生しました: ${err instanceof Error ? err.message : err}`,
      );
      continue;
    }

    if (result.access_token) {
      const tokens: CachedTokens = {
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: Date.now() + (result.expires_in ?? 0) * 1000,
      };
      await persistCache(state.cachePath, tokens);
      console.log(`[google-auth:${provider}] 認証が完了しました`);
      return;
    }
    if (result.error && result.error !== "authorization_pending") {
      if (result.error === "slow_down") continue;
      console.error(
        `[google-auth:${provider}] デバイスコードフローが失敗しました: ${result.error} ${result.error_description ?? ""}`,
      );
      return;
    }
  }

  console.error(
    `[google-auth:${provider}] デバイスコードフローがタイムアウトしました`,
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

  // 認証フローが既に進行中なら、同じ案内を返して再開要求しない
  if (state.pendingAuth) {
    throw new GoogleAuthRequiredError(provider, state.pendingAuth);
  }

  const deviceCode = (await postForm(DEVICE_CODE_URL, {
    client_id: state.config.clientId,
    scope: state.config.scopes.join(" "),
  })) as DeviceCodeResponse;

  const pending: PendingAuth = {
    verificationUrl: deviceCode.verification_url,
    userCode: deviceCode.user_code,
  };
  state.pendingAuth = pending;

  console.log(`\n[google-auth:${provider}] 認証が必要です`);
  console.log(
    `[google-auth:${provider}] ${pending.verificationUrl} を開き、コード ${pending.userCode} を入力してください`,
  );

  void pollDeviceCode(provider, state, deviceCode).finally(() => {
    if (state.pendingAuth === pending) state.pendingAuth = undefined;
  });

  throw new GoogleAuthRequiredError(provider, pending);
}
