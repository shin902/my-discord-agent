import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createToolProxyTool, type ToolProxyEndpoint } from "./tool-proxy.js";

export type CapabilityExecutor = "sandbox" | "host";
export type AgentToolFactory = () => AgentTool | undefined;
export type CapabilityArgsValidator = (args: unknown) => boolean;

export interface CapabilityDispatchContext {
  readonly toolProxyEndpoint?: ToolProxyEndpoint;
}

type CapabilityDefinitionBase = {
  readonly tool: string;
  readonly factory: AgentToolFactory;
};

export type CapabilityDefinition =
  | (CapabilityDefinitionBase & {
      readonly executor: "sandbox";
    })
  | (CapabilityDefinitionBase & {
      readonly executor: "host";
      /** Validate the wire arguments without changing the agent-facing schema. */
      readonly validateArgs: CapabilityArgsValidator;
    });

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
  }
}
