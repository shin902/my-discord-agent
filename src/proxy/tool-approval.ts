import type {
  ToolProxyRunAuthoritySnapshot,
  TrustedDiscordDestination,
} from "./tool-proxy-run-authority.js";

export type ToolApprovalDecision = "approve" | "deny";
export type ToolApprovalResult = "approved" | "denied";
export type ToolApprovalState =
  | "pending"
  | "claimed"
  | ToolApprovalResult
  | "failed"
  | "canceled";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CanonicalToolArgs {
  /** Immutable JSON value passed to the executor after approval. */
  readonly value: JsonValue;
  /** Exact generic representation shown in Discord or attached as a file. */
  readonly json: string;
}

export interface ToolApprovalInvocation {
  readonly runId: string;
  readonly capability: string;
  readonly destination: TrustedDiscordDestination;
  readonly args: CanonicalToolArgs;
}

export interface ToolApprovalClaim {
  readonly decision: ToolApprovalDecision;
  /** Record a successful Discord terminal-state update. */
  completeUiUpdate(): boolean;
  /** Record a failed or timed-out Discord terminal-state update. */
  failUiUpdate(reason?: unknown): boolean;
}

export interface ToolApprovalRequest {
  readonly invocation: ToolApprovalInvocation;
  readonly state: ToolApprovalState;
  /** Synchronously claim the first decision; later clicks lose. */
  claim(decision: ToolApprovalDecision): ToolApprovalClaim | undefined;
  /** Has no approval-specific deadline and settles with the run or UI result. */
  waitForDecision(): Promise<ToolApprovalResult>;
}

export class ToolApprovalCanceledError extends Error {
  constructor(options?: ErrorOptions) {
    super("Tool approval canceled because run authority was revoked", options);
    this.name = "ToolApprovalCanceledError";
  }
}

export class ToolApprovalUiUpdateError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Tool approval failed because the Discord update did not complete",
      options,
    );
    this.name = "ToolApprovalUiUpdateError";
  }
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}

/**
 * Snapshot already-materialized arguments once so display and execution derive
 * from the same JSON representation without invoking a materializer again.
 */
function canonicalizeMaterializedArgs(args: unknown): CanonicalToolArgs {
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

  const value = deepFreezeJson(JSON.parse(json) as JsonValue);
  return Object.freeze({ value, json });
}

class RunScopedToolApprovalRequest implements ToolApprovalRequest {
  readonly invocation: ToolApprovalInvocation;
  #state: ToolApprovalState = "pending";
  readonly #authority: ToolProxyRunAuthoritySnapshot;
  readonly #result: Promise<ToolApprovalResult>;
  readonly #resolve: (result: ToolApprovalResult) => void;
  readonly #reject: (reason: unknown) => void;

  constructor(
    authority: ToolProxyRunAuthoritySnapshot,
    capability: string,
    materializedArgs: unknown,
  ) {
    this.#authority = authority;
    const destination = authority.trustedDiscordDestination;
    if (!authority.allowedCapabilities.has(capability)) {
      throw new Error(
        `Capability is not authorized for this run: ${capability}`,
      );
    }
    if (!authority.approvalRequiredCapabilities.has(capability)) {
      throw new Error(`Capability does not require approval: ${capability}`);
    }
    if (!destination) {
      throw new Error(
        `Approval-required capability has no trusted Discord destination: ${capability}`,
      );
    }

    this.invocation = Object.freeze({
      runId: authority.runId,
      capability,
      destination,
      args: canonicalizeMaterializedArgs(materializedArgs),
    });

    let resolve!: (result: ToolApprovalResult) => void;
    let reject!: (reason: unknown) => void;
    this.#result = new Promise<ToolApprovalResult>(
      (resolveResult, rejectResult) => {
        resolve = resolveResult;
        reject = rejectResult;
      },
    );
    this.#resolve = resolve;
    this.#reject = reject;
    // A presenter can fail before its caller begins awaiting the result. Keep
    // the rejection observed while preserving it for waitForDecision().
    void this.#result.catch(() => undefined);

    authority.revokeSignal.addEventListener("abort", this.#cancel, {
      once: true,
    });
    if (authority.revokeSignal.aborted) this.#cancel();
  }

  get state(): ToolApprovalState {
    return this.#state;
  }

  claim(decision: ToolApprovalDecision): ToolApprovalClaim | undefined {
    if (this.#state !== "pending") return undefined;
    this.#state = "claimed";
    let open = true;

    return Object.freeze({
      decision,
      completeUiUpdate: () => {
        if (!open) return false;
        open = false;
        if (this.#state !== "claimed") return false;
        const result = decision === "approve" ? "approved" : "denied";
        this.#settle(result, () => this.#resolve(result));
        return true;
      },
      failUiUpdate: (reason?: unknown) => {
        if (!open) return false;
        open = false;
        if (this.#state !== "claimed") return false;
        this.#settle("failed", () =>
          this.#reject(new ToolApprovalUiUpdateError({ cause: reason })),
        );
        return true;
      },
    });
  }

  waitForDecision(): Promise<ToolApprovalResult> {
    return this.#result;
  }

  readonly #cancel = (): void => {
    if (this.#state !== "pending" && this.#state !== "claimed") return;
    this.#settle("canceled", () =>
      this.#reject(
        new ToolApprovalCanceledError({
          cause: this.#authority.revokeSignal.reason,
        }),
      ),
    );
  };

  #settle(state: ToolApprovalState, settleResult: () => void): void {
    this.#state = state;
    this.#authority.revokeSignal.removeEventListener("abort", this.#cancel);
    settleResult();
  }
}

/** Create one in-memory approval request bound to one run and invocation. */
export function createToolApprovalRequest(
  authority: ToolProxyRunAuthoritySnapshot,
  capability: string,
  materializedArgs: unknown,
): ToolApprovalRequest {
  return new RunScopedToolApprovalRequest(
    authority,
    capability,
    materializedArgs,
  );
}
