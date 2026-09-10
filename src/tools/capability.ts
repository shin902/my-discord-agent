import type {
  AgentTool,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import { Check, Clean, Clone } from "typebox/value";
import { createToolProxyTool, type ToolProxyEndpoint } from "./tool-proxy.js";

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

const runtimeValidatedTools = new WeakSet<object>();

/**
 * Guard direct executor calls with the same schema boundary used by proxy
 * capabilities. TypeBox object schemas keep unknown properties accepted, so
 * this wrapper validates the advertised properties and passes a cleaned clone
 * to the existing executor, matching host capability materialization.
 */
export function wrapToolInputValidation<T extends AgentTool>(
  tool: T,
  validator?: CapabilityArgsValidator,
): T {
  if (runtimeValidatedTools.has(tool)) return tool;

  const validateArgs = validator ?? validateToolArgs(tool);
  const materializeArgs = materializeToolArgs(tool);
  const originalExecute = tool.execute;
  tool.execute = (async (
    toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ) => {
    if (!validateArgs(args)) {
      throw new Error(`Invalid arguments for tool: ${tool.name}`);
    }
    return originalExecute.call(
      tool,
      toolCallId,
      materializeArgs(args) as never,
      signal,
      onUpdate,
    );
  }) as T["execute"];
  runtimeValidatedTools.add(tool);
  return tool;
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
      readonly executor: "host" | "runtime";
      /** Validate the wire arguments without changing the agent-facing schema. */
      readonly validateArgs: CapabilityArgsValidator;
      /** Resolve effective executor arguments after validation, when needed. */
      readonly materializeArgs?: CapabilityArgsMaterializer;
    });

/** Materialize once when configured; otherwise preserve identity. */
export function materializeCapabilityArgs(
  definition: Extract<CapabilityDefinition, { executor: "host" | "runtime" }>,
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
    case "sandbox": {
      const tool = definition.factory();
      return tool ? wrapToolInputValidation(tool) : undefined;
    }
    case "host":
    case "runtime": {
      const tool = definition.factory();
      return tool
        ? createToolProxyTool(tool, context.toolProxyEndpoint)
        : undefined;
    }
  }
}
