import type { Api, KnownProvider, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";
import {
  resolveBaseUrl,
  resolveModel,
  type ModelDependencies,
} from "./model.js";

const makeModel = (id: string, provider: string): Model<Api> => ({
  id,
  name: id,
  api: "openai-chat",
  provider,
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
});
const dependencies = (
  providers: KnownProvider[],
  credentials: CredentialEntry[],
  models: Model<Api>[] = [],
): ModelDependencies => ({
  getProviders: () => providers,
  getModels: () => models,
  loadCredentialProxy: async () => credentials,
});
const credential = (entry: CredentialEntry): CredentialEntry => entry;
const custom = (
  entry: Partial<CredentialEntry> &
    Pick<CredentialEntry, "provider" | "baseUrl">,
): CredentialEntry => entry;

describe("resolveModel", () => {
  it("既知のプロバイダーのモデルを解決する", async () => {
    const result = await resolveModel(
      "openai",
      "gpt-4",
      dependencies(["openai"], [], [makeModel("gpt-4", "openai")]),
    );
    expect(result.id).toBe("gpt-4");
    expect(result.provider).toBe("openai");
  });
  it("credential-proxy に定義されたカスタムプロバイダを解決する", async () => {
    const result = await resolveModel(
      "llama-cpp",
      "llama3",
      dependencies(
        [],
        [
          credential({
            provider: "llama-cpp",
            baseUrl: "http://localhost:8080/v1",
            api: "openai-completions",
          }),
        ],
      ),
    );
    expect(result).toMatchObject({
      id: "llama3",
      api: "openai-completions",
      provider: "llama-cpp",
      baseUrl: "http://localhost:8080/v1",
      input: ["text"],
    });
  });
  it("models[modelId].input で modelId 単位に入力モダリティを指定できる", async () => {
    const entry = custom({
      provider: "llama-cpp",
      baseUrl: "http://localhost:8080/v1",
      api: "openai-completions",
      models: { "qwen-vl": { input: ["text", "image"] } },
    });
    const deps = dependencies([], [entry]);
    expect((await resolveModel("llama-cpp", "qwen-vl", deps)).input).toEqual([
      "text",
      "image",
    ]);
    expect((await resolveModel("llama-cpp", "qwen-coder", deps)).input).toEqual(
      ["text"],
    );
  });
  it("forceCustom: true は既知プロバイダーにも適用される", async () => {
    const entry = custom({
      provider: "groq",
      forceCustom: true,
      baseUrl: "https://api.groq.com/openai/v1",
      api: "openai-completions",
    });
    const result = await resolveModel(
      "groq",
      "llama",
      dependencies(["groq"], [entry], [makeModel("llama", "groq")]),
    );
    expect(result).toMatchObject({
      provider: "groq",
      baseUrl: entry.baseUrl,
      id: "llama",
    });
  });
  it("forceCustom 未指定の場合は既知プロバイダー側から解決する", async () => {
    const entry = credential({
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
    });
    const result = await resolveModel(
      "groq",
      "llama",
      dependencies(["groq"], [entry], [makeModel("llama", "groq")]),
    );
    expect(result.id).toBe("llama");
  });
  it.each([
    [
      "thinkingFormat が reasoning を有効化",
      custom({
        provider: "qwen",
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
      true,
      { thinkingFormat: "qwen-chat-template" },
    ],
    [
      "reasoning true を維持",
      custom({
        provider: "reasoning",
        baseUrl: "http://localhost:9090/v1",
        api: "openai-completions",
        reasoning: true,
      }),
      true,
      undefined,
    ],
    [
      "reasoning false は thinkingFormat を無効化",
      custom({
        provider: "no-reasoning",
        baseUrl: "http://localhost:9090/v1",
        api: "openai-completions",
        reasoning: false,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
      false,
      undefined,
    ],
  ])("%s", async (_name, entry, reasoning, compat) => {
    const result = await resolveModel(
      entry.provider,
      "model",
      dependencies([], [entry]),
    );
    expect(result.reasoning).toBe(reasoning);
    expect(result.compat).toEqual(compat);
  });
  it("非 openai-completions の compat は付与しない", async () => {
    const entry = credential({
      provider: "anthropic-custom",
      baseUrl: "http://localhost:9090/v1",
      api: "anthropic-messages",
      compat: { thinkingFormat: "openai", thinkingLevelMap: { off: "none" } },
    });
    const result = await resolveModel(
      entry.provider,
      "model",
      dependencies([], [entry]),
    );
    expect(result.compat).toBeUndefined();
    expect(result.thinkingLevelMap).toBeUndefined();
    expect(result.reasoning).toBe(false);
  });
  it("thinkingLevelMap はトップレベルに渡される", async () => {
    const entry = credential({
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
      api: "openai-completions",
      compat: {
        thinkingFormat: "openrouter",
        thinkingLevelMap: { off: "none", minimal: "low", xhigh: "high" },
      },
    });
    const result = await resolveModel(
      entry.provider,
      "qwen3",
      dependencies([], [entry]),
    );
    expect(result.compat).toEqual({ thinkingFormat: "openrouter" });
    expect(result.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "low",
      xhigh: "high",
    });
  });
  it("thinkingLevelMap 省略時は undefined", async () => {
    const entry = credential({
      provider: "custom",
      baseUrl: "http://custom-host:8080/v1",
      api: "openai-completions",
      compat: { thinkingFormat: "qwen-chat-template" },
    });
    expect(
      (await resolveModel(entry.provider, "model", dependencies([], [entry])))
        .thinkingLevelMap,
    ).toBeUndefined();
  });
  it("thinkingFormat がない compat は undefined", async () => {
    const entry = credential({
      provider: "custom",
      baseUrl: "http://custom-host:8080/v1",
      api: "openai-completions",
      compat: {},
    });
    const result = await resolveModel(
      entry.provider,
      "model",
      dependencies([], [entry]),
    );
    expect(result.compat).toBeUndefined();
    expect(result.reasoning).toBe(false);
  });
  it("不明なプロバイダはエラー", async () => {
    await expect(
      resolveModel("unknown", "model", dependencies([], [])),
    ).rejects.toThrow("不明なプロバイダ: unknown");
  });
  it("baseUrl の未解決プレースホルダはエラー", async () => {
    const entry = credential({
      provider: "custom",
      baseUrl: "http://{UNSET_HOST}/v1",
    });
    await expect(
      resolveModel(entry.provider, "model", dependencies([], [entry])),
    ).rejects.toThrow("baseUrl に未解決のプレースホルダがあります");
  });
  it("既知プロバイダーでモデルがない場合はエラー", async () => {
    await expect(
      resolveModel("openai", "unknown-model", dependencies(["openai"], [], [])),
    ).rejects.toThrow("不明なモデル: unknown-model (provider: openai)");
  });
});

describe("resolveBaseUrl", () => {
  it("環境変数プレースホルダを解決する", () => {
    process.env.TEST_HOST = "localhost";
    expect(resolveBaseUrl("http://{TEST_HOST}:8080")).toBe(
      "http://localhost:8080",
    );
    delete process.env.TEST_HOST;
  });
  it("未解決のプレースホルダは null", () =>
    expect(resolveBaseUrl("http://{UNSET}/v1")).toBeNull());
  it("プレースホルダがない場合はそのまま返す", () =>
    expect(resolveBaseUrl("http://localhost:8080")).toBe(
      "http://localhost:8080",
    ));
});
