import type { RedditOAuthConfig } from "../config/credential-proxy.js";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

// アクセストークンの有効期限直前での失効を避けるための安全マージン
const EXPIRY_MARGIN_MS = 60_000;

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

type ProviderState = {
  config: RedditOAuthConfig;
  clientSecret: string;
  cached?: CachedToken;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

const registry = new Map<string, ProviderState>();

export async function initRedditAuth(
  provider: string,
  config: RedditOAuthConfig,
  clientSecret: string,
): Promise<void> {
  registry.set(provider, { config, clientSecret });
}

export async function getRedditAccessToken(provider: string): Promise<string> {
  const state = registry.get(provider);
  if (!state) {
    throw new Error(
      `Reddit Auth が初期化されていません (provider: ${provider})。initRedditAuth() を先に呼んでください`,
    );
  }

  if (
    state.cached &&
    state.cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()
  ) {
    return state.cached.accessToken;
  }

  // client_credentials グラント: アプリ単位の読み取り専用トークンを取得する
  // （ユーザー単位の認可は不要・無料tierの範囲内）
  const basicAuth = Buffer.from(
    `${state.config.clientId}:${state.clientSecret}`,
  ).toString("base64");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "discord-agent-credential-proxy/1.0",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });

  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) {
    throw new Error(
      `Reddit access token 取得失敗 (provider: ${provider}): ${data.error ?? res.status}`,
    );
  }

  state.cached = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return state.cached.accessToken;
}
