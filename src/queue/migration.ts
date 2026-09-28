import type { QueueRepository } from "./repository.js";

export async function initializeQueue(repo: QueueRepository): Promise<void> {
  const reserved = repo.db
    .prepare(
      "SELECT group_name, session_id FROM bot_task_sessions WHERE bot_id='main' LIMIT 1",
    )
    .get() as { group_name: string; session_id: string } | undefined;
  if (reserved)
    throw new Error(
      `Bot main の保存状態が不正です: main はMain専用の予約IDです (${reserved.group_name}/${reserved.session_id})`,
    );

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
