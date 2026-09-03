import { resolveBaseUrl } from "../agent/model.js";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import { loadRequestTimeoutMs } from "../config/proxy-config.js";
import {
  GoogleAuthRequiredError,
  getGoogleAccessToken,
} from "../proxy/google-auth.js";
import { getGraphAccessToken } from "../proxy/graph-auth.js";

function firstSetEnvVar(envVars: string[] | undefined): string | undefined {
  return envVars
    ?.map((name) => process.env[name])
    .find((value): value is string => Boolean(value));
}

/** Fetch an API from the host without exposing its credential route to the sandbox. */
export async function hostFetch(
  provider: string,
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<Response> {
  const entry = (await loadCredentialProxy()).find(
    (candidate) => candidate.provider === provider,
  );
  if (!entry) {
    throw new Error(
      `${provider} プロバイダーが CREDENTIAL_PROXY_JSON に見つかりません`,
    );
  }
  const baseUrl = resolveBaseUrl(entry.baseUrl);
  if (!baseUrl) {
    throw new Error(
      `${provider} プロバイダーが CREDENTIAL_PROXY_JSON に見つかりません`,
    );
  }

  const headers: Record<string, string> = {
    ...((init.headers ?? {}) as Record<string, string>),
  };
  try {
    if (entry.msal) {
      headers.Authorization = `Bearer ${await getGraphAccessToken(provider)}`;
    } else if (entry.google) {
      headers.Authorization = `Bearer ${await getGoogleAccessToken(provider)}`;
    } else {
      const apiKey = firstSetEnvVar(entry.envVars);
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    }
  } catch (error) {
    if (entry.msal) {
      console.error(
        `[credential-proxy] graph token 取得失敗: ${error instanceof Error ? error.message : error}`,
      );
      return new Response("Graph token acquisition failed", { status: 502 });
    }
    if (error instanceof GoogleAuthRequiredError) {
      console.log(`[credential-proxy] ${error.message}`);
      return new Response(error.message, { status: 502 });
    }
    console.error(
      `[credential-proxy] google token 取得失敗: ${error instanceof Error ? error.message : error}`,
    );
    return new Response("Google token acquisition failed", { status: 502 });
  }

  const timeoutSignal = AbortSignal.timeout(await loadRequestTimeoutMs());
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetch(
      `${baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
      {
        ...init,
        headers,
        signal: requestSignal,
      },
    );
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) {
      return new Response("Gateway Timeout", { status: 504 });
    }
    throw error;
  }
}
