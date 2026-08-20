import {
  type Api,
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
} from "@earendil-works/pi-ai";
import {
  type CredentialEntry,
  loadCredentialProxy,
} from "../config/credential-proxy.js";

export interface ModelDependencies {
  getProviders: () => KnownProvider[];
  getModels: (provider: KnownProvider) => Model<Api>[];
  loadCredentialProxy: () => Promise<CredentialEntry[]>;
}

const defaultDependencies: ModelDependencies = {
  getProviders,
  getModels: (provider) => getModels(provider),
  loadCredentialProxy,
};

function isKnownProvider(
  provider: string,
  providers: KnownProvider[],
): provider is KnownProvider {
  return providers.some((candidate) => candidate === provider);
}

export function resolveBaseUrl(baseUrl: string): string | null {
  const resolved = baseUrl.replace(/\{([A-Za-z0-9_]+)\}/g, (_, envVar: string) => {
    return process.env[envVar] ?? `{${envVar}}`;
  });
  if (/\{[A-Za-z0-9_]+\}/.test(resolved)) return null;
  return resolved;
}

function createCustomModel(
  entry: CredentialEntry,
  baseUrl: string,
  modelId: string,
): Model<Api> {
  const api = entry.api ?? "openai-completions";
  const compatConfig = api === "openai-completions" ? entry.compat : undefined;
  const thinkingLevelMap = compatConfig?.thinkingLevelMap;
  let compat: Model<"openai-completions">["compat"] | undefined;
  if (entry.reasoning !== false && compatConfig?.thinkingFormat !== undefined) {
    const { thinkingLevelMap: _thinkingLevelMap, ...rest } = compatConfig;
    compat = rest;
  }
  return {
    id: modelId,
    name: modelId,
    api,
    provider: entry.provider,
    baseUrl,
    reasoning: entry.reasoning ?? Boolean(compat?.thinkingFormat),
    input: entry.models?.[modelId]?.input ?? ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow ?? 128000,
    maxTokens: entry.maxTokens ?? 4096,
    thinkingLevelMap,
    compat,
  };
}

export async function resolveModel(
  provider: string,
  modelId: string,
  dependencies: ModelDependencies = defaultDependencies,
): Promise<Model<Api>> {
  const providers = dependencies.getProviders();
  const creds = await dependencies.loadCredentialProxy();
  const entry = creds.find((candidate) => candidate.provider === provider);

  if (entry?.forceCustom || !isKnownProvider(provider, providers)) {
    if (!entry) throw new Error(`不明なプロバイダ: ${provider}`);
    const resolvedBaseUrl = resolveBaseUrl(entry.baseUrl);
    if (!resolvedBaseUrl) {
      throw new Error(
        `${provider}: baseUrl に未解決のプレースホルダがあります（${entry.baseUrl}）`,
      );
    }
    return createCustomModel(entry, resolvedBaseUrl, modelId);
  }
  const model = dependencies.getModels(provider).find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`不明なモデル: ${modelId} (provider: ${provider})`);
  return model;
}

export async function validateModel(
  provider: string,
  modelId: string,
  dependencies?: ModelDependencies,
): Promise<void> {
  await resolveModel(provider, modelId, dependencies);
}
