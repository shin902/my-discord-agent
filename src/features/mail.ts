import { z } from "zod";
import { enqueueCronInbox } from "../cron/enqueue.js";
import { acknowledgeEmail } from "../cron/mail-ack.js";
import type { CronContext } from "../cron/runner.js";
import type { SourceHandlers } from "../queue/source-handlers.js";

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
      mailEmailId: emailId,
      mailRouteKey: routeKey,
    },
    content,
  );
}

export function registerMailSource(handlers: SourceHandlers): void {
  handlers.register("mail", mailInput, {
    activeOnlyIdempotency: true,
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
