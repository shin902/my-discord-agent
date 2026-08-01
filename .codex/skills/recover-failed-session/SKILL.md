---
name: recover-failed-session
description: Identify and recover failed JSONL agent sessions by finding unresolved tool-call failures, context-window errors, malformed PEG output, invalid UTF-8, or corrupt JSON records; remove the failed turn as an integrity-preserving record range; validate and back up the repaired session; and enqueue a failure-specific continuation in data/queue/inbox.jsonl. Use for my-discord-agent session recovery, especially when the user asks to retry, repair, resume, or recover a broken session.
---

# Recover failed sessions

Recover the active transcript instead of merely resending the original request.

## Workflow

1. Work from the `my-discord-agent` repository root.
2. If the user did not identify a session, scan recent sessions:

   ```bash
   .codex/skills/recover-failed-session/scripts/recover-session.mjs --repo "$PWD"
   ```

3. Correlate the candidate with the user-visible error, URL, response ID, backend log, or timestamp. Do not assume the newest file or a previously mentioned group is correct.
4. Preview a specific candidate when needed:

   ```bash
   .codex/skills/recover-failed-session/scripts/recover-session.mjs \
     --repo "$PWD" \
     --session data/sessions/<group>/<session>.jsonl
   ```

5. Inspect the reported failure type, record range, neighboring roles, destination, and generated continuation prompt. Read [references/recovery-rules.md](references/recovery-rules.md) when the range is ambiguous or tool-call pairing matters.
6. When the user requested recovery or retry, apply it without an additional confirmation:

   Before running `--apply`, report in the commentary channel exactly what will be
   requeued. Include:

   - the session's absolute path;
   - failure type, failure line, and record range to remove;
   - resolved destination channel ID, group, and cron job when applicable;
   - the exact continuation text that will be enqueued (or the explicit `--prompt`);
   - whether successful tool results will be retained and reused.

   This is a pre-action report, not a confirmation request. Continue automatically
   after reporting when the user already requested recovery or retry.

   ```bash
   .codex/skills/recover-failed-session/scripts/recover-session.mjs \
     --repo "$PWD" \
     --session data/sessions/<group>/<session>.jsonl \
     --apply
   ```

7. Monitor until the inbox record is consumed. Then verify:

   - the repaired session remains valid UTF-8 and JSONL;
   - the new assistant record has `stopReason` other than `error`;
   - no `�`, PEG parse warning, unmatched tool call, or context error recurred;
   - the Discord/poller outcome is successful when logs are available.

## Safety rules

- Delete complete JSONL records, never individual replacement characters or arbitrary bytes.
- Preserve a byte-for-byte backup before modifying a session.
- Remove the failed tool-call request together with its failed result when they form one pair.
- Keep successful tool results when only the following assistant generation failed; the continuation should reuse them without rerunning the tool.
- Never repair an already-resolved historical failure automatically.
- Refuse to enqueue when the channel cannot be resolved unambiguously. Inspect `config/cron.json`, inbox/dead-letter history, or the numeric session ID first.
- Do not enqueue a duplicate recovery while the same session already exists in `inbox.jsonl`.
- Never run `--apply` before reporting the exact requeue payload and absolute target
  path in the commentary channel.
- Treat queue insertion and Discord delivery as external actions. Only perform them when the user asked to recover, retry, or resume.

## Overrides

Use `--failure-line N` to select a reported 1-based failure line, `--channel-id ID` when automatic destination resolution is impossible, and `--prompt TEXT` only when the generated failure-specific continuation is inadequate.

The script prints a dry-run by default. `--apply` performs the backup, repair, validation, and queue append as one guarded operation.
