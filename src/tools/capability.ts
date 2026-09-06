import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { Check, Clean, Clone } from "typebox/value";
import { createToolProxyTool, type ToolProxyEndpoint } from "./tool-proxy.js";

export type CapabilityExecutor = "sandbox" | "host";
export type AgentToolFactory = () => AgentTool | undefined;
export type CapabilityArgsValidator = (args: unknown) => boolean;
export type CapabilityArgsMaterializer = (args: unknown) => unknown;

export interface ToolArgsMaterializerOptions {
  /** Values resolved once for each invocation when the caller omitted them. */
  readonly defaultArgs?: () => Readonly<Record<string, unknown>>;
  /** Schema-bounded numeric properties the executor historically clamps. */
  readonly clampedProperties?: readonly string[];
}

/**
 * Build effective executor arguments from an advertised tool schema.
 * Unknown properties are removed from a clone, leaving the wire input untouched.
 */
export function materializeToolArgs(
  tool: AgentTool,
  options: ToolArgsMaterializerOptions = {},
): CapabilityArgsMaterializer {
  const parameters = tool.parameters as TSchema & {
    properties?: Record<string, TSchema>;
  };
  const properties = parameters.properties ?? {};

  return (args) => {
    const materialized = Clean(parameters, Clone(args));
    if (
      typeof materialized !== "object" ||
      materialized === null ||
      Array.isArray(materialized)
    ) {
      return materialized;
    }

    const effectiveArgs = materialized as Record<string, unknown>;
    for (const [property, value] of Object.entries(
      options.defaultArgs?.() ?? {},
    )) {
      if (effectiveArgs[property] === undefined) {
        effectiveArgs[property] = Clone(value);
      }
    }

    for (const property of options.clampedProperties ?? []) {
      const value = effectiveArgs[property];
      if (typeof value !== "number") continue;
      const propertySchema = properties[property] as
        | (TSchema & { minimum?: number; maximum?: number })
        | undefined;
      if (!propertySchema) continue;
      effectiveArgs[property] = Math.min(
        propertySchema.maximum ?? Number.POSITIVE_INFINITY,
        Math.max(propertySchema.minimum ?? Number.NEGATIVE_INFINITY, value),
      );
    }

    return effectiveArgs;
  };
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
      /** Resolve effective executor arguments after validation, when needed. */
      readonly materializeArgs?: CapabilityArgsMaterializer;
    });

/** Materialize once when configured; otherwise preserve identity. */
export function materializeCapabilityArgs(
  definition: Extract<CapabilityDefinition, { executor: "host" }>,
  args: unknown,
): unknown {
  return definition.materializeArgs ? definition.materializeArgs(args) : args;
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
  }
}
