import type { CredentialEntry } from "../config/credential-proxy.js";

/** Resolve native wire authentication from trusted host configuration. */
export function nativeProviderAuth(entry: CredentialEntry) {
  if (entry.forceCustom) return entry.api;
  if (entry.provider === "anthropic") return "anthropic-messages";
  if (entry.provider === "google") return "google-generative-ai";
  return entry.api;
}

export function usesAnthropicOAuth(entry: CredentialEntry, key?: string) {
  return (
    !entry.msal &&
    !entry.google &&
    (!entry.auth || entry.auth.type === "bearer") &&
    nativeProviderAuth(entry) === "anthropic-messages" &&
    Boolean(key?.includes("sk-ant-oat"))
  );
}
