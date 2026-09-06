import { validateModel } from "../agent/model.js";
import { getCapabilityDefinition, resolveTools } from "../tools/registry.js";
import type { AgentConfig } from "./groups.js";
import { buildExtraMountArgs } from "./mounts.js";

/** Validate the opt-in approval selection on one effective AgentConfig. */
export function validateApprovalRequiredTools(
  config: Pick<AgentConfig, "tools" | "approvalRequiredTools">,
): void {
  const approvalRequiredTools = config.approvalRequiredTools ?? [];
  resolveTools(approvalRequiredTools);

  for (const toolName of approvalRequiredTools) {
    if (!config.tools.includes(toolName)) {
      throw new Error(
        `承認必須ツールは有効な tools に含めてください: ${toolName}`,
      );
    }
    if (getCapabilityDefinition(toolName)?.executor !== "host") {
      throw new Error(
        `承認必須ツールには host capability のみ指定できます: ${toolName}`,
      );
    }
  }
}

/** Validate one effective AgentConfig at startup. */
export async function validateAgentConfig(
  config: AgentConfig,
  defaultModel: { provider: string; modelId: string },
): Promise<void> {
  await validateModel(
    config.model?.provider ?? defaultModel.provider,
    config.model?.modelId ?? defaultModel.modelId,
  );
  resolveTools(config.tools);
  validateApprovalRequiredTools(config);
  buildExtraMountArgs(config.mounts ?? []);
}
