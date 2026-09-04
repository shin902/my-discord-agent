import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { createToolProxyTool, type ToolProxyEndpoint } from "./tool-proxy.js";

export type CapabilityExecutor = "sandbox" | "host";
export type AgentToolFactory = () => AgentTool | undefined;
export type CapabilityArgsValidator = (args: unknown) => boolean;

export interface CapabilityApprovalPolicy {
  /** Materialize the exact argument object that may execute after approval. */
  readonly normalizeArgs: (args: unknown) => unknown;
  /** Resolve the semantic resource independently from agent-supplied approval claims. */
  readonly target: (args: unknown) => string;
  readonly summary: (args: unknown) => string;
}

/** Reuse the advertised schema, relaxing only upper bounds the executor clamps. */
export function validateToolArgs(
  tool: AgentTool,
  clampedMaximumProperties: readonly string[] = [],
): CapabilityArgsValidator {
  const parameters = tool.parameters as TSchema & {
    properties?: Record<string, TSchema>;
  };
  const properties = { ...parameters.properties };
  for (const property of clampedMaximumProperties) {
    const propertySchema = properties[property];
    if (!propertySchema) continue;
    const relaxed: Record<string, unknown> = { ...propertySchema };
    delete relaxed.maximum;
    properties[property] = relaxed as TSchema;
  }
  const schema = { ...parameters, properties } as TSchema;
  return (args) => Check(schema, args);
}

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
      readonly approval?: CapabilityApprovalPolicy;
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
