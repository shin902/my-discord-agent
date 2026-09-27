import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerMailSource } from "../src/features/mail.js";
import { registerRssSource } from "../src/features/rss.js";
import { QueueRepository } from "../src/queue/repository.js";
import { SourceHandlers } from "../src/queue/source-handlers.js";
import { expectDefined } from "../src/test-utils.js";
import { convertIssue540Runtime } from "./convert-issue540-runtime.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("one-time Issue #540 runtime conversion", () => {
  it("imports an unconsumed legacy JSONL row before converting it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "issue540-legacy-"));
    directories.push(directory);
    const inboxPath = join(directory, "inbox.jsonl");
    writeFileSync(inboxPath, JSON.stringify({
      id: "legacy-mail", channelId: "channel", groupName: "group", sessionId: "session",
      content: "prompt", timestamp: new Date().toISOString(), retries: 0,
      mailEmailId: "email-1", idempotencyKey: "legacy-key",
    }) + "\n");
    const repo = new QueueRepository(join(directory, "runtime.sqlite"));
    try {
      await convertIssue540Runtime(repo, {
        inboxPath,
        deadLetterPath: join(directory, "missing-dead.jsonl"),
        archiveDir: join(directory, "archive"),
      });
      expect(repo.get("legacy-mail")?.feature).toEqual({ kind: "mail", input: { emailId: "email-1" } });
      expect(repo.getIdempotencyRecord("legacy-key")?.jobId).toBe("legacy-mail");
    } finally {
      repo.close();
    }
  });
  it("converts pending jobs, deliveries, dead letters and preserves queue relations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "issue540-convert-"));
    directories.push(directory);
    const repo = new QueueRepository(join(directory, "runtime.sqlite"));
    try {
      const mail = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "mail",
        timestamp: new Date().toISOString(),
        idempotencyKey: "mail-key",
      }).job;
      repo.db.prepare("UPDATE jobs SET payload_json=json_set(payload_json,'$.mailEmailId','email-1','$.mailRouteKey','route') WHERE id=?").run(mail.id);
      const mailClaim = expectDefined(repo.claim());
      repo.commitResult(mail.id, mailClaim.fencingToken, "response", {
        deliveryPayload: { mailEmailId: "email-1", mailRouteKey: "route" },
      });
      const rss = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "rss-session",
        content: "rss",
        timestamp: new Date().toISOString(),
        idempotencyKey: "rss-key",
      }).job;
      repo.db.prepare("UPDATE jobs SET payload_json=json_set(payload_json,'$.rssDispatchId','dispatch-1','$.rssStatePath','custom.sqlite3') WHERE id=?").run(rss.id);
      repo.db
        .prepare("INSERT INTO dead_letters(reason,payload_json,source,created_at) VALUES(?,?,?,?)")
        .run("malformed", "{not-json", "migration", new Date().toISOString());
      repo.db
        .prepare("INSERT INTO dead_letters(reason,payload_json,source,created_at) VALUES(?,?,?,?)")
        .run("orphan-context", JSON.stringify({ mailRouteKey: "orphan", rssStatePath: "orphan.sqlite" }), "queue", new Date().toISOString());
      repo.db
        .prepare("INSERT INTO dead_letters(reason,payload_json,source,created_at) VALUES(?,?,?,?)")
        .run("legacy", JSON.stringify({ rssDispatchId: "dispatch-2", rssStatePath: "other.sqlite3" }), "queue", new Date().toISOString());
      repo.db
        .prepare("INSERT INTO committed_conversations(turn_id,group_name,user_entry_id,assistant_entry_id,committed_at) VALUES(?,?,?,?,?)")
        .run("turn-1", "group", 1, 2, new Date().toISOString());
      const original = repo.db.prepare("SELECT id,status,attempts,fencing_token,session_id FROM jobs ORDER BY id").all();
      const paths = {
        inboxPath: join(directory, "missing-inbox.jsonl"),
        deadLetterPath: join(directory, "missing-dead.jsonl"),
        archiveDir: join(directory, "archive"),
      };
      await convertIssue540Runtime(repo, paths);
      expect(repo.db.prepare("SELECT id,status,attempts,fencing_token,session_id FROM jobs ORDER BY id").all()).toEqual(original);
      const convertedMail = expectDefined(repo.get(mail.id));
      expect(convertedMail.feature).toEqual({ kind: "mail", input: { emailId: "email-1", routeKey: "route" } });
      expect("mailEmailId" in convertedMail).toBe(false);
      const delivery = expectDefined(repo.claimDelivery("delivery-worker"));
      expect(JSON.parse(delivery.row.payloadJson ?? "{}").feature).toEqual(convertedMail.feature);
      expect(repo.listSourceInputs("rss")).toEqual([
        { dispatchId: "dispatch-1", dispatchJobId: "rss-key", statePath: "custom.sqlite3" },
      ]);
      expect(repo.listSourceInputs("mail")).toEqual([
        { emailId: "email-1", routeKey: "route" },
      ]);
      expect(repo.get(rss.id)?.feature).toEqual({
        kind: "rss",
        input: { dispatchId: "dispatch-1", dispatchJobId: "rss-key", statePath: "custom.sqlite3" },
      });
      expect(repo.db.prepare("SELECT source_kind,allow_failed_predecessor FROM jobs WHERE id=?").get(rss.id)).toEqual({ source_kind: "rss", allow_failed_predecessor: 1 });
      expect(repo.db.prepare("SELECT payload_json FROM dead_letters WHERE reason='legacy'").get()).toMatchObject({ payload_json: expect.stringContaining('"kind":"rss"') });
      expect(repo.db.prepare("SELECT payload_json FROM dead_letters WHERE reason='orphan-context'").get()).toEqual({ payload_json: JSON.stringify({ mailRouteKey: "orphan", rssStatePath: "orphan.sqlite" }) });
      expect(repo.db.prepare("SELECT payload_json FROM dead_letters WHERE reason='malformed'").get()).toEqual({ payload_json: "{not-json" });
      expect(repo.db.prepare("SELECT turn_id FROM committed_conversations").get()).toEqual({ turn_id: "turn-1" });
      expect(repo.getIdempotencyRecord("mail-key")?.jobId).toBe(mail.id);
      const handlers = new SourceHandlers();
      registerMailSource(handlers);
      registerRssSource(handlers, repo);
      repo.registerSources(handlers);
      const pending = expectDefined(repo.claim("post-conversion-worker"));
      expect(pending.job.id).toBe(rss.id);
      repo.commitResult(rss.id, pending.fencingToken, "<NO_REPLY>", { suppressDelivery: true });
      expect(repo.get(rss.id)?.status).toBe("completed");
      const next = repo.enqueue({
        channelId: "channel", groupName: "group", sessionId: "another", content: "new", timestamp: new Date().toISOString(),
        feature: { kind: "mail", input: { emailId: "new" } },
      });
      expect(next.inserted).toBe(true);
      await expect(convertIssue540Runtime(repo, paths)).rejects.toThrow(/already/);
    } finally {
      repo.close();
    }
  });
});
