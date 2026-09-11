import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import { readSourceTrajectories } from "../agent/session.js";
import { NonRetryableError } from "../utils/error.js";
import { MemoryExportLedger } from "./export-ledger.js";
import { TencentDbBackend } from "./tencentdb.js";
import type { MemoryCaptureBackend, MemoryCaptureTurn } from "./types.js";

export const MEMORY_EXPORT_HANDLER = "jobs/memory-export.ts";

const SettingsSchema = z.object({
  type: z.literal("tencentdb"),
  eligibleGroups: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).min(1),
  batchSize: z.number().int().positive().max(1000).default(50),
});

function text(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export function* readCaptureTurns(
  groupName: string,
): Generator<MemoryCaptureTurn> {
  for (const trajectory of readSourceTrajectories(groupName)) {
    let assistant: AgentMessage | undefined;
    for (const message of trajectory.following) {
      // A non-conversational prompt (e.g. cron or /skill) must not supply the answer.
      if (message.role === "user") break;
      if (
        message.role === "assistant" &&
        message.stopReason === "stop" &&
        !message.errorMessage &&
        text(message).trim()
      )
        assistant = message;
    }
    const userContent = text(trajectory.user);
    if (!assistant || !userContent.trim()) continue;
    yield {
      groupName,
      sessionId: trajectory.sessionId,
      source: trajectory.source,
      user: {
        content: userContent,
        timestamp:
          trajectory.source.createdAt ??
          new Date(trajectory.user.timestamp).toISOString(),
      },
      assistant: {
        content: text(assistant),
        timestamp: new Date(assistant.timestamp).toISOString(),
      },
    };
  }
}

/** A bounded batch. Acceptance is marked immediately; failures escape to the runtime queue. */
export async function exportBatch(
  backendId: string,
  groups: string[],
  batchSize: number,
  backend: MemoryCaptureBackend,
  ledger: MemoryExportLedger,
  signal?: AbortSignal,
): Promise<void> {
  let exported = 0;
  for (const group of groups) {
    for (const turn of readCaptureTurns(group)) {
      signal?.throwIfAborted();
      if (ledger.has(backendId, turn)) continue;
      await backend.exportTurn(turn);
      ledger.record(backendId, turn);
      if (++exported >= batchSize) return;
    }
  }
}

/** Settings are provided by the startup cron cache, never by a durable job snapshot. */
export async function runMemoryExport(
  backendId: string,
  settings: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const parsed = SettingsSchema.safeParse(settings);
  if (!parsed.success)
    throw new NonRetryableError("Invalid Memory export settings");
  const backend = new TencentDbBackend(settings, signal);
  const ledger = new MemoryExportLedger();
  try {
    await exportBatch(
      backendId,
      parsed.data.eligibleGroups,
      parsed.data.batchSize,
      backend,
      ledger,
      signal,
    );
  } finally {
    ledger.close();
  }
}
