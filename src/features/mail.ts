import { z } from "zod";
import { enqueueCronInbox } from "../cron/enqueue.js";
import { acknowledgeEmail } from "../cron/mail-ack.js";
import type { CronContext } from "../cron/runner.js";
import type { QueueRepository } from "../queue/repository.js";
import type { SourceHandlers } from "../queue/source-handlers.js";
import { assertValidRepoPart, GITHUB_HEADERS } from "../tools/github.js";
import { hostFetch } from "../tools/host-fetch.js";

interface MailMetadata {
  subject: string;
  senderAddress: string;
  headers: Array<{ name: string; value: string }>;
}

function githubRepository(meta: MailMetadata): string | undefined {
  if (meta.senderAddress.trim().toLowerCase() !== "notifications@github.com")
    return undefined;
  const listId = meta.headers.find(
    (header) => header.name.toLowerCase() === "list-id",
  )?.value;
  const repo = listId?.match(/^\s*([\w.-]+)\/([\w.-]+)(?:\s|$)/i);
  if (!repo) return undefined;
  assertValidRepoPart(repo[1], "owner");
  assertValidRepoPart(repo[2], "repo");
  return `${repo[1]}/${repo[2]}`.toLowerCase();
}

export function mailRouteKey(meta: MailMetadata): string {
  const repo = githubRepository(meta);
  const item = meta.subject.match(/\((?:PR )?#(\d+)\)\s*$/);
  if (repo && item) return `github:${repo}:item:${item[1]}`;
  return `mail:${meta.senderAddress.trim().toLowerCase()}`;
}

export async function resolveMailRouteKey(meta: MailMetadata): Promise<string> {
  const routeKey = mailRouteKey(meta);
  const repository = githubRepository(meta);
  const commit = meta.subject.match(
    /^(?:Re: )?\[[^\]]+\] PR run failed: .+ \(([a-f\d]{7,40})\)\s*$/i,
  );
  if (!repository || !commit) return routeKey;
  const response = await hostFetch(
    "github",
    `/repos/${repository}/commits/${commit[1]}/pulls?per_page=100`,
    { headers: GITHUB_HEADERS },
  );
  if (!response.ok)
    throw new Error(`GitHub PR mail routing API error ${response.status}`);
  const pulls = (await response.json()) as Array<{
    number: number;
    base: { repo: { full_name: string } };
  }>;
  if (pulls.length >= 100) return routeKey;
  const numbers = new Set(
    pulls
      .filter((pull) => pull.base.repo.full_name.toLowerCase() === repository)
      .map((pull) => pull.number)
      .filter((number) => Number.isSafeInteger(number) && number > 0),
  );
  const [number] = numbers;
  return numbers.size === 1 && number !== undefined
    ? `github:${repository}:item:${number}`
    : routeKey;
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

export function registerMailSource(
  handlers: SourceHandlers,
  repository: QueueRepository,
): void {
  handlers.register("mail", mailInput, {
    activeOnlyIdempotency: true,
    threadRoute(input, groupName, channelId) {
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
