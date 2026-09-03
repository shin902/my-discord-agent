import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createToolProxyTool, type ToolProxyEndpoint } from "./tool-proxy.js";

export type CapabilityExecutor = "sandbox" | "host";
export type AgentToolFactory = () => AgentTool | undefined;

export interface CapabilityDispatchContext {
  readonly toolProxyEndpoint?: ToolProxyEndpoint;
}

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
  context: CapabilityDispatchContext = {},
): AgentTool | undefined {
  switch (definition.executor) {
    case "sandbox":
      return definition.factory();
    case "host": {
      const tool = definition.factory();
      return tool
        ? createToolProxyTool(tool, context.toolProxyEndpoint)
        : undefined;
    }
    default: {
      const unreachable: never = definition.executor;
      throw new Error(`Unknown capability executor: ${unreachable}`);
    }
  }
}
