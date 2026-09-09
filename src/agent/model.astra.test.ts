import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";

vi.mock("../config/credential-proxy.js", () => ({
  loadCredentialProxy: vi.fn(),
}));

const { resolveModel } = await import("./model.js");
const { loadCredentialProxy } = await import("../config/credential-proxy.js");

describe("Astra model catalog compatibility", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIAL_PROXY_JSON", "");
    vi.mocked(loadCredentialProxy).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    {
      provider: "openai",
      api: "openai-responses",
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    },
    {
      provider: "openai-codex",
      api: "openai-codex-responses",
      thinkingLevelMap: {
        off: null,
        minimal: "low",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    },
  ] as const)("resolves gpt-6-astra with $provider metadata", async ({
    provider,
    api,
    thinkingLevelMap,
  }) => {
    const model = await resolveModel(provider, "gpt-6-astra");

    expect(model).toMatchObject({
      id: "gpt-6-astra",
      provider,
      api,
      reasoning: true,
      contextWindow: 272000,
      maxTokens: 128000,
      thinkingLevelMap,
    });
  });

  it.each([
    {
      provider: "openai",
      modelId: "gpt-5.6-sol",
      api: "openai-responses",
    },
    {
      provider: "openai-codex",
      modelId: "gpt-5.6-luna",
      api: "openai-codex-responses",
    },
  ] as const)("keeps the existing $provider/$modelId route available", async ({
    provider,
    modelId,
    api,
  }) => {
    const catalogModel = getModel(provider, modelId);
    const model = await resolveModel(provider, modelId);

    expect(model).toMatchObject({
      id: modelId,
      provider,
      api,
      baseUrl: catalogModel.baseUrl,
    });
  });

  it("keeps the existing custom Sol/Luna provider models available", async () => {
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "codex-oauth",
        forceCustom: true,
        envVars: ["CLIPROXY_API_KEY"],
        baseUrl: "http://localhost:8317/v1",
        api: "openai-responses",
        models: {
          "gpt-5.6-luna": { input: ["text", "image"] },
          "gpt-5.6-sol": { input: ["text", "image"] },
        },
      },
    ] as CredentialEntry[]);

    for (const modelId of ["gpt-5.6-luna", "gpt-5.6-sol"] as const) {
      await expect(resolveModel("codex-oauth", modelId)).resolves.toMatchObject(
        {
          id: modelId,
          provider: "codex-oauth",
          api: "openai-responses",
          baseUrl: "http://localhost:8317/v1",
          input: ["text", "image"],
        },
      );
    }
  });
});
