import { loadRawConfig } from "./config.js";
import { type ModelConfig, ModelConfigSchema } from "./groups.js";

export async function loadDefaultModel(): Promise<ModelConfig> {
  const raw = await loadRawConfig();
  if (raw.defaultModel === undefined) {
    throw new Error(
      "config/config.json に defaultModel が設定されていません。config.example.json を参考に設定してください",
    );
  }
  return ModelConfigSchema.parse(raw.defaultModel);
}

/** グループのモデル設定を config.json の defaultModel で補完する */
export async function resolveModelConfig(
  model?: ModelConfig,
): Promise<ModelConfig> {
  const defaultModel = await loadDefaultModel();
  return {
    provider: model?.provider ?? defaultModel.provider,
    modelId: model?.modelId ?? defaultModel.modelId,
    ...(model?.thinkingLevel !== undefined
      ? { thinkingLevel: model.thinkingLevel }
      : {}),
  };
}
