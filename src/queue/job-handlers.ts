import type { InboxMessage } from "./types.js";

/** Explicit in-process runners for durable jobs that never invoke an Agent. */
export class JobHandlers {
  private readonly runners = new Map<
    string,
    (message: InboxMessage, signal?: AbortSignal) => Promise<void>
  >();

  register(
    kind: string,
    runner: (message: InboxMessage, signal?: AbortSignal) => Promise<void>,
  ): void {
    if (!kind || this.runners.has(kind))
      throw new Error(`duplicate or empty job kind: ${kind}`);
    this.runners.set(kind, runner);
  }

  async run(message: InboxMessage, signal?: AbortSignal): Promise<void> {
    const runner = message.jobKind && this.runners.get(message.jobKind);
    if (!runner) throw new Error(`unregistered job kind: ${message.jobKind}`);
    await runner(message, signal);
  }
}
