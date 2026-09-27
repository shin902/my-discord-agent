import type { QueueRepository } from "./repository.js";

export async function initializeQueue(repo: QueueRepository): Promise<void> {
  // Reject unconverted SQLite payloads before workers can claim them.
  const old = repo.db
    .prepare(
      `SELECT 1 FROM jobs WHERE json_type(payload_json,'$.mailEmailId') IS NOT NULL
       OR json_type(payload_json,'$.rssDispatchId') IS NOT NULL
       OR (json_type(payload_json,'$.feature') IS NOT NULL AND source_kind IS NULL)
       LIMIT 1`,
    )
    .get();
  if (old)
    throw new Error("Issue #540 runtime conversion is required before startup");
  // Managed containers are stopped before recovering direct-admission markers
  // from the previous process, so no detached runner can append to a transcript.
  repo.recoverBotTaskSessionAdmissions();
  repo.recoverExpired();
}
