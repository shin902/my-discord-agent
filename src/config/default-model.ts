import { loadRawConfig } from "./config.js";
import { type ModelConfig, ModelConfigSchema } from "./groups.js";

// サンドボックスコンテナ（config.json を読めない）で groupConfig.model が未設定の場合に使うデフォルト。agent-runner.ts を単独実行するときの安全網。
// 通常運用では manager.ts が loadDefaultModel() の結果を必ず groupConfig.model に詰めてコンテナに渡すため、この値が使われることはない。
export const FALLBACK_DEFAULT_MODEL: ModelConfig = {
  provider: "opencode-go",
  modelId: "kimi-k2.6",
};

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
