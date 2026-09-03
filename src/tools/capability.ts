import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import { createToolProxyTool, type ToolProxyEndpoint } from "./tool-proxy.js";

export type CapabilityExecutor = "sandbox" | "host";
export type AgentToolFactory = () => AgentTool | undefined;
export type CapabilityArgsValidator = (args: unknown) => boolean;

const EXECUTOR_CONSTRAINTS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
]);

function structuralSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuralSchema);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !EXECUTOR_CONSTRAINTS.has(key))
      .map(([key, child]) => [key, structuralSchema(child)]),
  );
}

/** Reuse the advertised schema while leaving clamps and semantic checks to the executor. */
export function validateToolArgs(tool: AgentTool): CapabilityArgsValidator {
  const schema = structuralSchema(tool.parameters) as TSchema;
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
