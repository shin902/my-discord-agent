import { validateModel } from "../agent/model.js";
import { resolveTools } from "../tools/registry.js";
import type { AgentConfig } from "./groups.js";
import { buildExtraMountArgs } from "./mounts.js";

/** Validate one effective AgentConfig at startup. */
export async function validateAgentConfig(
  config: AgentConfig,
  defaultModel: { provider: string; modelId: string },
): Promise<void> {
  await validateModel(
    config.model?.provider ?? defaultModel.provider,
    config.model?.modelId ?? defaultModel.modelId,
  );
  resolveTools(config.tools ?? []);
  buildExtraMountArgs(config.mounts ?? []);
}
