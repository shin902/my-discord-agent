import { loadRawConfig } from "./config.js";
import { type ModelConfig, ModelConfigSchema } from "./groups.js";

// config.json に defaultModel が指定されていない場合のフォールバック。
// サンドボックスコンテナ（config.json を読めない）でも同じ値を使うため、
// agent-runner.ts からこの定数を直接 import して利用する。
export const FALLBACK_DEFAULT_MODEL: ModelConfig = {
  provider: "opencode-go",
  modelId: "kimi-k2.6",
};

export async function loadDefaultModel(): Promise<ModelConfig> {
  const raw = await loadRawConfig();
  if (raw.defaultModel === undefined) return FALLBACK_DEFAULT_MODEL;
  return ModelConfigSchema.parse(raw.defaultModel);
}
