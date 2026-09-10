import { describe, expect, it } from "vitest";
import type { CredentialEntry } from "./credential-proxy.js";
import { isLlmCredential } from "./llm-credentials.js";

describe("LLM credential declarations", () => {
  it.each([
    "openai",
    "openai-codex",
    "anthropic",
    "google",
    "opencode-go",
  ])("recognizes built-in %s without custom metadata", (provider) => {
    expect(isLlmCredential({ provider, baseUrl: "http://fixture.test" })).toBe(
      true,
    );
  });
  it.each([
    { api: "openai-responses" as const },
    { forceCustom: true },
  ])("preserves custom model declarations: %j", (declaration) => {
    expect(
      isLlmCredential({
        provider: "private-gateway",
        baseUrl: "http://fixture.test",
        ...declaration,
      }),
    ).toBe(true);
  });
  it.each([
    "github",
    "tavily",
    "google-calendar",
    "reddit",
    "graph",
    "future-integration",
  ])("does not publish untyped integration %s", (provider) => {
    expect(
      isLlmCredential({
        provider,
        baseUrl: "http://fixture.test",
        envVars: ["SECRET"],
      }),
    ).toBe(false);
  });
  it.each([
    { msal: { tenantId: "t", clientId: "c", scopes: [] } },
    { google: { clientId: "c", clientSecretEnvVar: "SECRET", scopes: [] } },
    { redditCookie: { cookieFile: "private.json", maxAgeDays: 7 } },
  ])("integration authentication cannot become an LLM route: %j", (auth) => {
    const entry: CredentialEntry = {
      provider: "openai",
      baseUrl: "http://fixture.test",
      api: "openai-responses",
      forceCustom: true,
      ...auth,
    };
    expect(isLlmCredential(entry)).toBe(false);
  });
});
