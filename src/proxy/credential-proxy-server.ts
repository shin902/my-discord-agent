import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import { resolveBaseUrl } from "../agent/model.js";
import {
  type CredentialEntry,
  loadCredentialProxy,
} from "../config/credential-proxy.js";
import { loadRequestTimeoutMs } from "../config/proxy-config.js";
import {
  GoogleAuthRequiredError,
  getGoogleAccessToken,
  initGoogleAuth,
} from "./google-auth.js";
import { getGraphAccessToken, initGraphAuth } from "./graph-auth.js";
import { getRedditCookieHeader } from "./reddit-cookie-store.js";

class UpstreamTimeoutError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "UpstreamTimeoutError";
  }
}

let proxyPort: number | null = null;
interface InternalRequestAuthorization {
  scope: string;
  /** Provider whose serial lock is held by the parent run, if any. */
  heldProvider?: string;
}
const internalRequestTokens = new Map<string, InternalRequestAuthorization>();
let internalRequestHandler:
  | ((
      req: IncomingMessage,
      res: ServerResponse,
      scope: string,
      heldProvider?: string,
    ) => Promise<void>)
  | null = null;

export interface InternalRequestConfig {
  port: number;
  token: string;
}

/** Register the host-only handler used by sandbox agent tools. */
export function registerInternalRequestHandler(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    scope: string,
    heldProvider?: string,
  ) => Promise<void>,
): void {
  internalRequestHandler = handler;
}

/** Issue a short-lived, group-scoped credential for one sandbox run. */
export function createInternalRequestConfig(
  scope: string,
  heldProvider?: string,
): InternalRequestConfig | undefined {
  if (proxyPort === null) return undefined;
  const token = randomUUID();
  internalRequestTokens.set(token, { scope, heldProvider });
  setTimeout(() => internalRequestTokens.delete(token), 15 * 60_000).unref();
  return { port: proxyPort, token };
}

export function getProxyPort(): number {
  if (proxyPort === null)
    throw new Error("credential proxy server は未初期化です");
  return proxyPort;
}

function getFirstSetEnvVar(envVars: string[] | undefined): string | undefined {
  for (const envVar of envVars ?? []) {
    const val = process.env[envVar];
    if (val) return val;
  }
  return undefined;
}

function appendPath(basePath: string, restPath: string): string {
  return `${basePath.replace(/\/$/, "")}/${restPath.replace(/^\//, "")}`;
}

async function handleRequest(
  creds: CredentialEntry[],
  timeoutMs: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const parsedReqUrl = new URL(url, "http://localhost");
  const pathname = parsedReqUrl.pathname;
  const search = parsedReqUrl.search;

  const secondSlash = pathname.indexOf("/", 1);
  const provider =
    secondSlash === -1 ? pathname.slice(1) : pathname.slice(1, secondSlash);
  const restPath = secondSlash === -1 ? "/" : pathname.slice(secondSlash);

  const entry = creds.find((e) => e.provider === provider);
  if (!entry) {
    res.writeHead(404);
    res.end(`Unknown provider: ${provider}`);
    return;
  }

  const resolvedBaseUrl = resolveBaseUrl(entry.baseUrl);
  if (!resolvedBaseUrl) {
    res.writeHead(502);
    res.end(`Cannot resolve baseUrl for provider: ${provider}`);
    return;
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(resolvedBaseUrl);
  } catch {
    res.writeHead(502);
    res.end("Invalid target URL");
    return;
  }
  parsedTarget.pathname = appendPath(parsedTarget.pathname, restPath);
  const reqSearchParams = new URLSearchParams(search);
  for (const [key, value] of reqSearchParams) {
    parsedTarget.searchParams.append(key, value);
  }

  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() !== "host") headers[k] = v;
  }

  if (entry.msal) {
    // MSALトークン注入（Graph API用）
    let token: string;
    try {
      token = await getGraphAccessToken(entry.provider);
    } catch (err) {
      console.error(
        `[credential-proxy] graph token 取得失敗: ${err instanceof Error ? err.message : err}`,
      );
      res.writeHead(502);
      res.end("Graph token acquisition failed");
      return;
    }
    delete headers.authorization;
    headers.authorization = `Bearer ${token}`;
  } else if (entry.google) {
    // Google OAuth トークン注入（Google Calendar API 等用）
    let token: string;
    try {
      token = await getGoogleAccessToken(entry.provider);
    } catch (err) {
      if (err instanceof GoogleAuthRequiredError) {
        console.log(`[credential-proxy] ${err.message}`);
        res.writeHead(502);
        res.end(err.message);
        return;
      }
      console.error(
        `[credential-proxy] google token 取得失敗: ${err instanceof Error ? err.message : err}`,
      );
      res.writeHead(502);
      res.end("Google token acquisition failed");
      return;
    }
    delete headers.authorization;
    headers.authorization = `Bearer ${token}`;
  } else if (entry.redditCookie) {
    // Reddit クッキー注入（agent-reach の reddit サービス用）
    let cookieHeader: string;
    try {
      cookieHeader = await getRedditCookieHeader(
        entry.provider,
        entry.redditCookie,
      );
    } catch (err) {
      console.error(
        `[credential-proxy] reddit cookie 取得失敗: ${err instanceof Error ? err.message : err}`,
      );
      res.writeHead(502);
      res.end("Reddit cookie unavailable");
      return;
    }
    delete headers.authorization;
    delete headers.cookie;
    headers.cookie = cookieHeader;
  } else if (entry.envVars && entry.envVars.length > 0) {
    const apiKey = getFirstSetEnvVar(entry.envVars);
    delete headers.authorization;
    if (apiKey) {
      if (entry.auth?.type === "query-token") {
        parsedTarget.searchParams.set(entry.auth.queryParam ?? "token", apiKey);
      } else if (entry.auth?.type === "basic") {
        // git smart-HTTP（github.com への clone/fetch）は Authorization: Bearer を
        // 受け付けず Basic 認証が必要。GitHub の慣習に合わせ username 省略時は
        // "x-access-token" を使う（actions/checkout 等と同じ方式）
        const username = entry.auth.username ?? "x-access-token";
        const basicCredential = Buffer.from(`${username}:${apiKey}`).toString(
          "base64",
        );
        headers.authorization = `Basic ${basicCredential}`;
      } else {
        headers.authorization = `Bearer ${apiKey}`;
      }
    }
  }

  const isHttps = parsedTarget.protocol === "https:";
  const httpModule = isHttps ? https : http;
  const defaultPort = isHttps ? 443 : 80;

  const options = {
    hostname: parsedTarget.hostname,
    port: parsedTarget.port ? Number(parsedTarget.port) : defaultPort,
    path: parsedTarget.pathname + parsedTarget.search,
    method: req.method,
    headers,
    timeout: timeoutMs,
  };

  await new Promise<void>((resolve, reject) => {
    const upstream = httpModule.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on("end", resolve);
      upstreamRes.on("error", (err) => {
        // upstream.destroyed === false: 通常の midstream エラー。upstream.on("error") より
        // 先に発火した場合は reject() が有効。後に発火した場合は Promise が settled 済みで
        // no-op になるが、.catch() → res.headersSent チェック → upstream.on("error") →
        // res.destroy(err) の順で処理されるため動作は正しい。
        // upstream.destroyed === true: タイムアウト等で destroy() 済みのため
        // Promise は upstream.on("error") により既に settled。reject() は no-op なのでログのみ。
        if (!upstream.destroyed) {
          reject(err);
        } else {
          console.error(
            `[credential-proxy] upstreamRes error after upstream destroyed for ${provider}: ${err.message}`,
          );
        }
      });
    });

    upstream.on("timeout", () => {
      upstream.destroy(
        new UpstreamTimeoutError(`upstream timeout for ${provider}`),
      );
    });

    upstream.on("error", (err) => {
      console.error(
        `[credential-proxy] upstream error for ${provider}: ${err.message}`,
      );
      if (!res.headersSent) {
        if (err instanceof UpstreamTimeoutError) {
          res.writeHead(504);
          res.end("Gateway Timeout");
        } else {
          res.writeHead(502);
          res.end("Bad Gateway");
        }
        // レスポンス書き込み済み。Promise を正常終了扱いにして outer catch に委ねない
        resolve();
      } else {
        // ヘッダ送信済みのため 504 を返せない。ソケットを強制切断してクライアントに
        // 不完全なレスポンスとして通知する（無言の打ち切り 200 を防ぐ）
        res.destroy(err);
        resolve();
      }
    });

    req.pipe(upstream);
  });
}

export function createRequestHandler(
  creds: CredentialEntry[],
  timeoutMs: number,
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/__agent/bot") {
      const token = req.headers["x-agent-internal-token"];
      const authorization =
        typeof token === "string"
          ? internalRequestTokens.get(token)
          : undefined;
      if (internalRequestHandler && authorization !== undefined) {
        internalRequestHandler(
          req,
          res,
          authorization.scope,
          authorization.heldProvider,
        ).catch((err) => {
          if (!res.headersSent) {
            console.error(`[credential-proxy] internal request failed: ${err}`);
            res.writeHead(500);
            res.end("Internal Server Error");
          }
        });
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    handleRequest(creds, timeoutMs, req, res).catch((err) => {
      if (!res.headersSent) {
        console.error(`[credential-proxy] unhandled error: ${err}`);
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });
  };
}

export async function initCredentialProxyServer(): Promise<number> {
  const [creds, timeoutMs] = await Promise.all([
    loadCredentialProxy(),
    loadRequestTimeoutMs(),
  ]);

  // MSALが必要なプロバイダーを初期化
  for (const entry of creds) {
    if (entry.msal) {
      await initGraphAuth(entry.provider, entry.msal);
      console.log(
        `[credential-proxy] Graph Auth initialized for provider: ${entry.provider}`,
      );
    }
    if (entry.google) {
      const clientSecret = process.env[entry.google.clientSecretEnvVar];
      if (!clientSecret) {
        console.warn(
          `[credential-proxy] ${entry.google.clientSecretEnvVar} が未設定のため provider ${entry.provider} の Google Auth をスキップします`,
        );
        continue;
      }
      await initGoogleAuth(entry.provider, entry.google, clientSecret);
      console.log(
        `[credential-proxy] Google Auth initialized for provider: ${entry.provider}`,
      );
      // 初回利用時のデバイスコードフローを起動時にトリガーしておく。
      // 認証未完了の場合 getGoogleAccessToken は GoogleAuthRequiredError を
      // 即座に投げ、ポーリングはバックグラウンドで継続する（ここではブロックしない）。
      try {
        await getGoogleAccessToken(entry.provider);
      } catch (err) {
        if (err instanceof GoogleAuthRequiredError) {
          console.log(`[credential-proxy] ${err.message}`);
        } else {
          console.error(
            `[credential-proxy] Google Auth トークン取得に失敗しました (provider: ${entry.provider}): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
    if (entry.redditCookie) {
      try {
        await getRedditCookieHeader(entry.provider, entry.redditCookie);
        console.log(
          `[credential-proxy] Reddit cookie OK for provider: ${entry.provider}`,
        );
      } catch (err) {
        console.warn(
          `[credential-proxy] ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  const server = http.createServer(createRequestHandler(creds, timeoutMs));

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "0.0.0.0", () => {
      proxyPort = (server.address() as { port: number }).port;
      console.log(
        `[credential-proxy] HTTP proxy listening on port ${proxyPort}`,
      );
      resolve();
    });
  });

  return getProxyPort();
}
