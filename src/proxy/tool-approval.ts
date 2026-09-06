import type { TrustedDiscordDestination } from "./tool-proxy-server.js";

export interface ToolApprovalRequestInput {
  readonly runId: string;
  readonly capability: string;
  readonly trustedDiscordDestination: TrustedDiscordDestination;
  readonly revokeSignal: AbortSignal;
}

export interface CanonicalToolArgs {
  readonly value: unknown;
  readonly json: string;
}

export interface ToolApprovalInvocation {
  readonly runId: string;
  readonly capability: string;
  readonly trustedDiscordDestination: TrustedDiscordDestination;
  readonly args: CanonicalToolArgs;
}

export interface ToolApprovalClaim {
  readonly decision: "approve" | "deny";
  completeUiUpdate(): boolean;
  failUiUpdate(reason?: unknown): boolean;
}

export interface ToolApprovalRequest {
  readonly invocation: ToolApprovalInvocation;
  claim(decision: "approve" | "deny"): ToolApprovalClaim | undefined;
  waitForDecision(): Promise<"approved" | "denied">;
}

function freezeSnapshot(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) freezeSnapshot(child);
  return Object.freeze(value);
}

function canonicalizeArgs(args: unknown): CanonicalToolArgs {
  let json: string | undefined;
  try {
    json = JSON.stringify(args, null, 2);
  } catch (error) {
    throw new Error("Materialized tool arguments must be JSON-serializable", {
      cause: error,
    });
  }
  if (json === undefined) {
    throw new Error("Materialized tool arguments must be JSON-serializable");
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new Error("Materialized tool arguments must be JSON-serializable", {
      cause: error,
    });
  }
  return Object.freeze({
    value: freezeSnapshot(value),
    json,
  });
}

class ApprovalRequest implements ToolApprovalRequest {
  readonly invocation: ToolApprovalInvocation;
  readonly #revokeSignal: AbortSignal;
  #claimed = false;
  #settled = false;
  readonly #result: Promise<"approved" | "denied">;
  readonly #resolve: (result: "approved" | "denied") => void;
  readonly #reject: (reason: unknown) => void;

  constructor(input: ToolApprovalRequestInput, materializedArgs: unknown) {
    this.#revokeSignal = input.revokeSignal;
    this.invocation = Object.freeze({
      runId: input.runId,
      capability: input.capability,
      trustedDiscordDestination: Object.freeze({
        ...input.trustedDiscordDestination,
      }),
      args: canonicalizeArgs(materializedArgs),
    });

    let resolve!: (result: "approved" | "denied") => void;
    let reject!: (reason: unknown) => void;
    this.#result = new Promise((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    this.#resolve = resolve;
    this.#reject = reject;
    void this.#result.catch(() => undefined);

    input.revokeSignal.addEventListener("abort", this.#cancel, { once: true });
    if (input.revokeSignal.aborted) this.#cancel();
  }

  claim(decision: "approve" | "deny"): ToolApprovalClaim | undefined {
    if (this.#claimed || this.#settled) return undefined;
    this.#claimed = true;
    let open = true;
    return Object.freeze({
      decision,
      completeUiUpdate: () => {
        if (!open || this.#settled) return false;
        open = false;
        const result = decision === "approve" ? "approved" : "denied";
        this.#settle(() => this.#resolve(result));
        return true;
      },
      failUiUpdate: (reason?: unknown) => {
        if (!open || this.#settled) return false;
        open = false;
        this.#settle(() =>
          this.#reject(
            new Error("Tool approval Discord update failed", {
              cause: reason,
            }),
          ),
        );
        return true;
      },
    });
  }

  waitForDecision(): Promise<"approved" | "denied"> {
    return this.#result;
  }

  readonly #cancel = (): void => {
    if (this.#settled) return;
    this.#settle(() =>
      this.#reject(
        new Error("Tool approval canceled because run authority was revoked", {
          cause: this.#revokeSignal.reason,
        }),
      ),
    );
  };

  #settle(settleResult: () => void): void {
    this.#settled = true;
    this.#revokeSignal.removeEventListener("abort", this.#cancel);
    settleResult();
  }
}

export function createToolApprovalRequest(
  input: ToolApprovalRequestInput,
  materializedArgs: unknown,
): ToolApprovalRequest {
  return new ApprovalRequest(input, materializedArgs);
}
