import { getProviders } from "@earendil-works/pi-ai/compat";
import type { CredentialEntry } from "./credential-proxy.js";

/** Positive model declaration, not run-scoped authorization. Unknown integrations stay host-only. */
export function isLlmCredential(entry: CredentialEntry): boolean {
  if (entry.msal || entry.google || entry.redditCookie) return false;
  return (
    entry.api !== undefined ||
    entry.forceCustom === true ||
    (getProviders() as string[]).includes(entry.provider)
  );
}
