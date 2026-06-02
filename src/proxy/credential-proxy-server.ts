import type { IncomingMessage, ServerResponse } from "node:http";
import * as http from "node:http";
import * as https from "node:https";
import { resolveBaseUrl } from "../agent/model.js";
import {
  type CredentialEntry,
  loadCredentialProxy,
} from "../config/credential-proxy.js";
import { getGraphAccessToken, initGraphAuth } from "./graph-auth.js";

let proxyPort: number | null = null;

export function getProxyPort(): number {
  if (proxyPort === null)
    throw new Error("credential proxy server は未初期化です");
  return proxyPort;
}

async function handleRequest(
  creds: CredentialEntry[],
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

  const targetUrlStr = resolvedBaseUrl.replace(/\/$/, "") + restPath + search;

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrlStr);
  } catch {
    res.writeHead(502);
    res.end("Invalid target URL");
    return;
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
    headers.authorization = `Bearer ${token}`;
  } else if (entry.envVars && entry.envVars.length > 0) {
    let apiKey: string | undefined;
    for (const envVar of entry.envVars) {
      const val = process.env[envVar];
      if (val) {
        apiKey = val;
        break;
      }
    }
    delete headers.authorization;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
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
  };

  await new Promise<void>((resolve, reject) => {
    const upstream = httpModule.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on("end", resolve);
      upstreamRes.on("error", reject);
    });

    upstream.on("error", (err) => {
      console.error(
        `[credential-proxy] upstream error for ${provider}: ${err.message}`,
      );
      if (!res.headersSent) {
        res.writeHead(502);
        res.end("Bad Gateway");
      }
      reject(err);
    });

    req.pipe(upstream);
  });
}

export function createRequestHandler(creds: CredentialEntry[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    handleRequest(creds, req, res).catch((err) => {
      if (!res.headersSent) {
        console.error(`[credential-proxy] unhandled error: ${err}`);
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });
  };
}

export async function initCredentialProxyServer(): Promise<number> {
  const creds = await loadCredentialProxy();

  // MSALが必要なプロバイダーを初期化
  for (const entry of creds) {
    if (entry.msal) {
      await initGraphAuth(entry.provider, entry.msal);
      console.log(
        `[credential-proxy] Graph Auth initialized for provider: ${entry.provider}`,
      );
    }
  }

  const server = http.createServer(createRequestHandler(creds));

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
