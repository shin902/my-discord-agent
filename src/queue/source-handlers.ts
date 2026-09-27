import type { z } from "zod";
import type { DeliveryRow } from "./repository.js";
import type { InboxMessage } from "./types.js";

export type SourceEnvelope = { kind: string; input: unknown };
export type SourceResolution = "completed" | "dead_letter";
export type SourceDeliveryStatus = DeliveryRow["status"];

export interface SourceCallbacks<T> {
  /** Graph unread and RSS dispatch claims have different terminal semantics. */
  activeOnlyIdempotency?: boolean;
  /** RSS continues past a failed response chunk; ordinary sources do not. */
  continueAfterFailedChunk?: boolean;
  /** A failed RSS Agent run releases its claim instead of retrying that queue job. */
  terminalOnAgentFailure?: boolean;
  threadRouteKey?: (input: T) => string | undefined;
  suppressed?: (input: T, message: InboxMessage) => Promise<void> | void;
  terminal?: (input: T, message: InboxMessage) => Promise<void> | void;
  delivery?: (
    input: T,
    row: DeliveryRow,
    statuses: readonly SourceDeliveryStatus[],
  ) => Promise<void> | void;
}

interface RegisteredSource {
  activeOnlyIdempotency: boolean;
  continueAfterFailedChunk: boolean;
  terminalOnAgentFailure: boolean;
  suppressed: (input: unknown, message: InboxMessage) => Promise<void>;
  terminal: (input: unknown, message: InboxMessage) => Promise<void>;
  delivery: (
    input: unknown,
    row: DeliveryRow,
    statuses: readonly SourceDeliveryStatus[],
  ) => Promise<void>;
  validate: (input: unknown) => unknown;
  threadRouteKey: (input: unknown) => string | undefined;
}

/** No global registration order: startup and standalone workers share an explicit instance. */
export class SourceHandlers {
  private readonly sources = new Map<string, RegisteredSource>();

  register<T>(
    kind: string,
    schema: z.ZodType<T>,
    callbacks: SourceCallbacks<T>,
  ): void {
    if (!kind || this.sources.has(kind))
      throw new Error(`duplicate or empty source kind: ${kind}`);
    const validate = (input: unknown): T => {
      const result = schema.safeParse(input);
      if (!result.success)
        throw new Error(
          `invalid ${kind} source input: ${result.error.message}`,
        );
      return result.data;
    };
    this.sources.set(kind, {
      activeOnlyIdempotency: callbacks.activeOnlyIdempotency ?? false,
      continueAfterFailedChunk: callbacks.continueAfterFailedChunk ?? false,
      terminalOnAgentFailure: callbacks.terminalOnAgentFailure ?? false,
      validate,
      threadRouteKey: (input) => callbacks.threadRouteKey?.(validate(input)),
      suppressed: async (input, message) => {
        await callbacks.suppressed?.(validate(input), message);
      },
      terminal: async (input, message) => {
        await callbacks.terminal?.(validate(input), message);
      },
      delivery: async (input, row, statuses) => {
        await callbacks.delivery?.(validate(input), row, statuses);
      },
    });
  }

  private resolve(envelope: SourceEnvelope): RegisteredSource {
    const source = this.sources.get(envelope.kind);
    if (!source) throw new Error(`unregistered source kind: ${envelope.kind}`);
    source.validate(envelope.input);
    return source;
  }

  policy(envelope: SourceEnvelope): {
    activeOnlyIdempotency: boolean;
    continueAfterFailedChunk: boolean;
    terminalOnAgentFailure: boolean;
  } {
    const source = this.resolve(envelope);
    return {
      activeOnlyIdempotency: source.activeOnlyIdempotency,
      continueAfterFailedChunk: source.continueAfterFailedChunk,
      terminalOnAgentFailure: source.terminalOnAgentFailure,
    };
  }

  threadRouteKey(envelope: SourceEnvelope): string | undefined {
    return this.resolve(envelope).threadRouteKey(envelope.input);
  }

  async suppressed(message: InboxMessage): Promise<void> {
    if (message.feature) {
      await this.resolve(message.feature).suppressed(
        message.feature.input,
        message,
      );
    }
  }

  async terminal(message: InboxMessage): Promise<void> {
    if (message.feature) {
      await this.resolve(message.feature).terminal(
        message.feature.input,
        message,
      );
    }
  }

  async delivery(
    envelope: SourceEnvelope,
    row: DeliveryRow,
    statuses: readonly SourceDeliveryStatus[],
  ): Promise<void> {
    await this.resolve(envelope).delivery(envelope.input, row, statuses);
  }
}
