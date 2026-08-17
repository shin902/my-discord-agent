const TRANSIENT_PATTERNS = [
  /timeout/i,
  /rate.limit/i,
  /429/i,
  /5\d\d/,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /socket hang up/i,
  /network/i,
  /temporarily unavailable/i,
];

export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/** Structured stderr envelope used to preserve typed runner failures across Docker. */
export const AGENT_ERROR_PREFIX = "__AGENT_ERROR__:";

export type AgentErrorPayload = {
  kind: "configuration";
  message: string;
};

export function parseAgentErrorPayload(
  value: unknown,
): AgentErrorPayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const payload = value as { kind?: unknown; message?: unknown };
  if (payload.kind !== "configuration" || typeof payload.message !== "string") {
    return undefined;
  }
  return { kind: "configuration", message: payload.message };
}

/**
 * A local configuration prevented an agent run from starting.
 *
 * This remains a NonRetryableError so queue consumers keep the existing
 * terminal-error handling, while the dedicated type prevents a configuration
 * message from being mistaken for a successful agent response.
 */
export class ConfigurationError extends NonRetryableError {
  readonly kind = "configuration" as const;

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function isConfigurationError(
  error: unknown,
): error is ConfigurationError {
  if (error instanceof ConfigurationError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { kind?: unknown }).kind === "configuration"
  );
}

export class TransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientError";
  }
}
