# Recovery rules

## Failure classification

| Type | Evidence | Remove | Continuation |
|---|---|---|---|
| `format` | `stopReason: error`, PEG/native-format parse error | Failed assistant record only | Reuse existing successful tool results and regenerate the final response |
| `invalid-utf8` | Fatal UTF-8 decode failure or corrupt JSON line | Entire corrupt record; also remove an immediately preceding unmatched tool call | Regenerate the interrupted response |
| `tool` | `toolResult.isError: true` or explicit tool-call failure | Failed tool result and its immediately preceding assistant tool-call record | Retry the tool operation once, respecting the error |
| `context` | Context window, maximum tokens, prompt-too-long error | Failed assistant record | Respond concisely from retained context; avoid rereading large sources |
| `generic` | Other unresolved assistant `stopReason: error` | Failed assistant record | Retry the interrupted response once |

Do not classify a failure as unresolved when a later successful assistant turn already handled it. Invalid UTF-8 remains structurally unresolved even if later bytes exist because the session loader may still fail.

## Transcript integrity

Agent messages store tool calls inside an assistant `content` array:

```json
{"role":"assistant","content":[{"type":"toolCall","id":"call-1","name":"bash","arguments":{}}]}
{"role":"toolResult","toolCallId":"call-1","toolName":"bash","isError":true}
```

If the failed result is removed, remove the corresponding assistant tool-call record too. An orphaned tool result or pending tool call can make the next API request invalid.

If a successful tool result is followed by malformed assistant output, retain both the tool call and tool result. Remove only the malformed assistant record and tell the model not to rerun the tool.

## Destination resolution

Resolve queue fields in this order:

1. Matching record in `data/queue/inbox.jsonl` or `dead-letter.jsonl`.
2. A purely numeric session ID, treated as its Discord channel ID.
3. A `cron-<job-id>-...` session matched against `config/cron.json`.
4. Explicit `--channel-id`.

For cron recovery, retain `cronDeliveryMode`, `cronSessionMode`, `cronJobId`, and its model/tool/skill override. For an ordinary session, enqueue only the normal channel/group/session fields.

## Context overflow

Removing the error record does not reduce a genuinely oversized history. First try the concise continuation because the runner may compact history. If it fails again:

- identify the largest stale tool result;
- preserve it in the backup;
- replace or remove it only with explicit user authority;
- alternatively retry with a larger-context model through `configOverride`.

Do not silently delete unrelated conversation history.

## Post-apply checks

Validate the active session with fatal UTF-8 decoding and line-by-line JSON parsing. Monitor the exact queue ID rather than assuming disappearance means failure: the poller removes it on successful model completion. Confirm success from the newly appended assistant record and, when available, the `response_timing` journal entry.
