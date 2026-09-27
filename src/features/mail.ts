import { z } from "zod";
import { enqueueCronInbox } from "../cron/enqueue.js";
import { acknowledgeEmail } from "../cron/mail-ack.js";
import type { CronContext } from "../cron/runner.js";
import type { QueueRepository } from "../queue/repository.js";
import type { SourceHandlers } from "../queue/source-handlers.js";

export function mailRouteKey({
  subject,
  senderAddress,
  headers,
}: {
  subject: string;
  senderAddress: string;
  headers: Array<{ name: string; value: string }>;
}): string {
  const sender = senderAddress.trim().toLowerCase();
  if (sender === "notifications@github.com") {
    const listId = headers.find(
      (header) => header.name.toLowerCase() === "list-id",
    )?.value;
    const repo = listId?.match(/^\s*([\w.-]+)\/([\w.-]+)(?:\s|$)/i);
    const item = subject.match(/\(#(\d+)\)\s*$/);
    if (repo && item)
      return `github:${repo[1].toLowerCase()}/${repo[2].toLowerCase()}:item:${item[1]}`;
  }
  return `mail:${sender}`;
}

const mailInput = z.object({
  emailId: z.string().min(1),
  routeKey: z.string().optional(),
});
export type MailSourceInput = z.infer<typeof mailInput>;

export async function enqueueMail(
  ctx: CronContext,
  content: string,
  emailId: string,
  routeKey: string,
): Promise<void> {
  await enqueueCronInbox(
    {
      ...ctx,
      deliveryMode: "direct",
      sessionMode: "per-run",
      idempotencyKey: `mail:graph:${encodeURIComponent(ctx.id)}:${encodeURIComponent(emailId)}`,
      feature: { kind: "mail", input: mailInput.parse({ emailId, routeKey }) },
    },
    content,
  );
}

export function getMailThread(
  repository: QueueRepository,
  groupName: string,
  channelId: string,
  routeKey: string,
): string | undefined {
  const row = repository.db
    .prepare(
      "SELECT thread_id AS threadId FROM mail_threads WHERE group_name=? AND channel_id=? AND route_key=?",
    )
    .get(groupName, channelId, routeKey) as { threadId: string } | undefined;
  return row?.threadId;
}

export function setMailThread(
  repository: QueueRepository,
  groupName: string,
  channelId: string,
  routeKey: string,
  threadId: string,
): void {
  repository.db
    .prepare(
      `INSERT INTO mail_threads(group_name,channel_id,route_key,thread_id,updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(group_name,channel_id,route_key) DO UPDATE SET
         thread_id=excluded.thread_id,updated_at=excluded.updated_at`,
    )
    .run(groupName, channelId, routeKey, threadId, new Date().toISOString());
}

export function registerMailSource(handlers: SourceHandlers): void {
  handlers.register("mail", mailInput, {
    activeOnlyIdempotency: true,
    threadRoute(input, repository, groupName, channelId) {
      if (!input.routeKey) return undefined;
      const routeKey = input.routeKey;
      return {
        name: routeKey
          .replace(/^mail:/, "")
          .replace(/^github:(.+):item:(\d+)$/, "$1 #$2")
          .slice(0, 100),
        resolve: () =>
          getMailThread(repository, groupName, channelId, routeKey),
        persist: (threadId) =>
          setMailThread(repository, groupName, channelId, routeKey, threadId),
      };
    },
    async suppressed(input) {
      await acknowledgeEmail(input.emailId);
    },
    async delivery(input, _row, statuses) {
      if (
        statuses.length > 0 &&
        statuses.every((status) => status === "sent")
      ) {
        await acknowledgeEmail(input.emailId);
      }
    },
  });
}
