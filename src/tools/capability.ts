import type { AgentTool } from "@earendil-works/pi-agent-core";

export type CapabilityExecutor = "sandbox" | "host";
export type AgentToolFactory = () => AgentTool | undefined;

export interface CapabilityDefinition {
  readonly tool: string;
  readonly executor: CapabilityExecutor;
  readonly factory: AgentToolFactory;
}

/**
 * Dispatch a trusted capability definition without exposing executor selection
 * to the agent-facing tool contract.
 */
export function dispatchCapability(
  definition: CapabilityDefinition,
): AgentTool | undefined {
  switch (definition.executor) {
    case "sandbox":
      return definition.factory();
    case "host":
      throw new Error(
        `Capability "${definition.tool}" cannot be dispatched: host executor is not implemented`,
      );
    default: {
      const unreachable: never = definition.executor;
      throw new Error(`Unknown capability executor: ${unreachable}`);
    }
  }
}
