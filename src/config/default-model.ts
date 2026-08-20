import { loadRawConfig, type JsonValue } from "./config.js";
import { type ModelConfig, ModelConfigSchema } from "./groups.js";

// サンドボックスコンテナ（config.json を読めない）で groupConfig.model が未設定の場合に使うデフォルト。agent-runner.ts を単独実行するときの安全網。
// 通常運用では manager.ts が loadDefaultModel() の結果を必ず groupConfig.model に詰めてコンテナに渡すため、この値が使われることはない。
// opencode-go の kimi-k2.6 は大規模なツールコールで API エラーが頻発し非推奨（#107）。GLM-4.7-flash は zai の無料枠（並列実行1まで・コンテキスト制限なし）で動かせるため後継に採用。
export const FALLBACK_DEFAULT_MODEL: ModelConfig = {
  provider: "zai",
  modelId: "glm-4.7-flash",
};

export async function loadDefaultModel(
  loadConfig: () => Promise<Record<string, JsonValue>> = loadRawConfig,
): Promise<ModelConfig> {
  const raw = await loadConfig();
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
  const resolved: ModelConfig = {
    provider: model?.provider ?? defaultModel.provider,
    modelId: model?.modelId ?? defaultModel.modelId,
  };
  if (model?.thinkingLevel !== undefined) {
    resolved.thinkingLevel = model.thinkingLevel;
  }
  return resolved;
}
