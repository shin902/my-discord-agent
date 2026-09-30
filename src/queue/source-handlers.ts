import type { z } from "zod";
import type { DeliveryRow } from "./repository.js";
import type { InboxMessage } from "./types.js";

export type SourceEnvelope = { kind: string; input: unknown };
export type ThreadRoute = {
  name: string;
  resolve: () => string | undefined;
  persist: (threadId: string) => Promise<void> | void;
};

export type PreparedImages = {
  imagePaths: string[];
  cleanup: () => Promise<void>;
};

export interface SourceCallbacks<T> {
  /** Prepare per-attempt Agent images; poller always cleans up after sendMessage. */
  prepareImages?: (
    input: T,
    message: InboxMessage,
  ) => Promise<PreparedImages | undefined>;
  /** Graph unread and RSS dispatch claims have different terminal semantics. */
  activeOnlyIdempotency?: boolean;
  /** RSS continues past a failed response chunk; ordinary sources do not. */
  continueAfterFailedChunk?: boolean;
  /** A failed RSS Agent run releases its claim instead of retrying that queue job. */
  terminalOnAgentFailure?: boolean;
  threadRoute?: (
    input: T,
    groupName: string,
    channelId: string,
  ) => ThreadRoute | undefined;
  suppressed?: (input: T, message: InboxMessage) => Promise<void> | void;
  terminal?: (input: T, message: InboxMessage) => Promise<void> | void;
  delivery?: (
    input: T,
    row: DeliveryRow,
    statuses: readonly DeliveryRow["status"][],
  ) => Promise<void> | void;
}

interface RegisteredSource {
  prepareImages: (
    input: unknown,
    message: InboxMessage,
  ) => Promise<PreparedImages | undefined>;
  activeOnlyIdempotency: boolean;
  continueAfterFailedChunk: boolean;
  terminalOnAgentFailure: boolean;
  suppressed: (input: unknown, message: InboxMessage) => Promise<void>;
  terminal: (input: unknown, message: InboxMessage) => Promise<void>;
  delivery: (
    input: unknown,
    row: DeliveryRow,
    statuses: readonly DeliveryRow["status"][],
  ) => Promise<void>;
  validate: (input: unknown) => unknown;
  threadRoute: (
    input: unknown,
    groupName: string,
    channelId: string,
  ) => ThreadRoute | undefined;
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
      prepareImages: async (input, message) =>
        callbacks.prepareImages?.(validate(input), message),
      threadRoute: (input, groupName, channelId) =>
        callbacks.threadRoute?.(validate(input), groupName, channelId),
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

  threadRoute(
    envelope: SourceEnvelope,
    groupName: string,
    channelId: string,
  ): ThreadRoute | undefined {
    return this.resolve(envelope).threadRoute(
      envelope.input,
      groupName,
      channelId,
    );
  }

  async prepareImages(
    message: InboxMessage,
  ): Promise<PreparedImages | undefined> {
    return message.feature
      ? this.resolve(message.feature).prepareImages(
          message.feature.input,
          message,
        )
      : undefined;
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
    statuses: readonly DeliveryRow["status"][],
  ): Promise<void> {
    await this.resolve(envelope).delivery(envelope.input, row, statuses);
  }
}
