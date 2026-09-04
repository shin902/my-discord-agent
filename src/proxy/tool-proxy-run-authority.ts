export interface TrustedDiscordDestination {
  readonly botId: string;
  readonly channelId: string;
}

export interface ToolProxyRunAuthoritySnapshot {
  readonly runId: string;
  readonly allowedCapabilities: ReadonlySet<string>;
  readonly approvalRequiredCapabilities: ReadonlySet<string>;
  /** null means this run cannot present an approval request and must fail closed. */
  readonly trustedDiscordDestination: TrustedDiscordDestination | null;
  readonly revokeSignal: AbortSignal;
}

export interface ToolProxyRunAuthorityInput {
  readonly runId: string;
  readonly allowedCapabilities: Iterable<string>;
  readonly approvalRequiredCapabilities?: Iterable<string>;
  readonly trustedDiscordDestination?: TrustedDiscordDestination;
}

export interface RevocableToolProxyRunAuthority {
  readonly snapshot: ToolProxyRunAuthoritySnapshot;
  revoke(): void;
}

/** Read-only facade that owns a copy rather than exposing its mutable Set. */
class CapabilitySetSnapshot implements ReadonlySet<string> {
  readonly #values: Set<string>;

  constructor(values: Iterable<string>) {
    this.#values = new Set(values);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: string): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[string, string]> {
    return this.#values.entries();
  }

  keys(): SetIterator<string> {
    return this.#values.keys();
  }

  values(): SetIterator<string> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (
      value: string,
      value2: string,
      set: ReadonlySet<string>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) {
      callbackfn.call(thisArg, value, value, this);
    }
  }

  [Symbol.iterator](): SetIterator<string> {
    return this.#values[Symbol.iterator]();
  }
}

class TrustedDiscordDestinationSnapshot implements TrustedDiscordDestination {
  readonly #botId: string;
  readonly #channelId: string;

  constructor(destination: TrustedDiscordDestination) {
    this.#botId = destination.botId;
    this.#channelId = destination.channelId;
  }

  get botId(): string {
    return this.#botId;
  }

  get channelId(): string {
    return this.#channelId;
  }
}

class RunAuthoritySnapshot implements ToolProxyRunAuthoritySnapshot {
  readonly #runId: string;
  readonly #allowedCapabilities: ReadonlySet<string>;
  readonly #approvalRequiredCapabilities: ReadonlySet<string>;
  readonly #trustedDiscordDestination: TrustedDiscordDestination | null;
  readonly #revokeSignal: AbortSignal;

  constructor(input: {
    runId: string;
    allowedCapabilities: ReadonlySet<string>;
    approvalRequiredCapabilities: ReadonlySet<string>;
    trustedDiscordDestination: TrustedDiscordDestination | null;
    revokeSignal: AbortSignal;
  }) {
    this.#runId = input.runId;
    this.#allowedCapabilities = input.allowedCapabilities;
    this.#approvalRequiredCapabilities = input.approvalRequiredCapabilities;
    this.#trustedDiscordDestination = input.trustedDiscordDestination;
    this.#revokeSignal = input.revokeSignal;
  }

  get runId(): string {
    return this.#runId;
  }

  get allowedCapabilities(): ReadonlySet<string> {
    return this.#allowedCapabilities;
  }

  get approvalRequiredCapabilities(): ReadonlySet<string> {
    return this.#approvalRequiredCapabilities;
  }

  get trustedDiscordDestination(): TrustedDiscordDestination | null {
    return this.#trustedDiscordDestination;
  }

  get revokeSignal(): AbortSignal {
    return this.#revokeSignal;
  }
}

/** Capture one run's host authority and its trusted Discord destination by value. */
export function createToolProxyRunAuthority(
  input: ToolProxyRunAuthorityInput,
): RevocableToolProxyRunAuthority {
  const allowedCapabilities = new CapabilitySetSnapshot(
    input.allowedCapabilities,
  );
  const approvalRequiredCapabilities = new CapabilitySetSnapshot(
    input.approvalRequiredCapabilities ?? [],
  );
  for (const capability of approvalRequiredCapabilities) {
    if (!allowedCapabilities.has(capability)) {
      throw new Error(
        `Approval-required capability is not allowed for this run: ${capability}`,
      );
    }
  }

  const controller = new AbortController();
  const snapshot = new RunAuthoritySnapshot({
    runId: input.runId,
    allowedCapabilities,
    approvalRequiredCapabilities,
    trustedDiscordDestination: input.trustedDiscordDestination
      ? new TrustedDiscordDestinationSnapshot(input.trustedDiscordDestination)
      : null,
    revokeSignal: controller.signal,
  });

  return {
    snapshot,
    revoke: () => controller.abort(new Error("Run authority revoked")),
  };
}
