import { loadCredentialProxy } from "../config/credential-proxy.js";
import {
  GoogleAuthRequiredError,
  getGoogleAccessToken,
  initGoogleAuth,
} from "./google-auth.js";
import { initGraphAuth } from "./graph-auth.js";

/** Initialize host-only integration credentials, independently of LLM forwarding. */
export async function initToolCredentials(): Promise<void> {
  for (const entry of await loadCredentialProxy()) {
    if (entry.msal) await initGraphAuth(entry.provider, entry.msal);
    if (!entry.google) continue;
    const clientSecret = process.env[entry.google.clientSecretEnvVar];
    if (!clientSecret) {
      console.warn(
        `[tool-credentials] ${entry.google.clientSecretEnvVar} が未設定のため provider ${entry.provider} の Google Auth をスキップします`,
      );
      continue;
    }
    await initGoogleAuth(entry.provider, entry.google, clientSecret);
    // Trigger device flow without blocking startup while waiting for approval.
    try {
      await getGoogleAccessToken(entry.provider);
    } catch (err) {
      if (err instanceof GoogleAuthRequiredError) {
        console.log(`[tool-credentials] ${err.message}`);
      } else {
        console.error(
          `[tool-credentials] Google Auth トークン取得に失敗しました (provider: ${entry.provider}): ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
