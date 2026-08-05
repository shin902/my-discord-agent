---
name: session-logs
description: "Search and aggregate your past conversation logs (session JSONL) with jq/grep. Use this when asked about past context not in MEMORY.md, such as 「前に話したこと覚えてる?」 or 「先週何の話した?」."
---

# session-logs

Search and aggregate this group's past sessions (conversation history) with jq/grep.

## When to use

- The user asks about past conversations or previous exchanges, but there is no corresponding entry in `MEMORY.md`.
- Prompts such as 「先週」, 「前に」, 「過去ログ」, or 「何回くらいやり取りした?」.
- You need to review your own messages or tool-usage history.

## Log location

`/sessions/*/*.jsonl`

- One file = one session (the Discord channel/thread ID is the filename).
- Each line = one message (JSON, one object per line).
- Only your own group's directory is mounted, so logs from other groups are not visible.

## Structure of each line

There is no wrapper structure; each message object is directly one line.

```json
{"role": "user", "content": [{"type": "text", "text": "..."}], "timestamp": 1780531201389}
```

- `role`: `"user"` | `"assistant"` | `"toolResult"`
- `content[]`: `type` is `"text"` (the message body) or `"toolCall"` (a tool invocation with `name`/`arguments`).
- `timestamp`: Unix epoch milliseconds (not an ISO string).
- `assistant` lines also include `usage.cost.total` / `usage.totalTokens` / `model` / `provider` / `stopReason`.
- `toolResult` lines contain `toolName` / `toolCallId` / `isError`, and the result text is in `content[]`.

## Common queries

### List sessions (date and size)

```bash
for f in /sessions/*/*.jsonl; do
  ts=$(head -1 "$f" | jq -r '.timestamp')
  date=$(TZ=Asia/Tokyo date -d "@$((ts/1000))" +%F)
  size=$(ls -lh "$f" | awk '{print $5}')
  echo "$date $size $f"
done | sort -r
```

### Find sessions on a specific date

```bash
for f in /sessions/*/*.jsonl; do
  ts=$(head -1 "$f" | jq -r '.timestamp')
  [ "$(TZ=Asia/Tokyo date -d "@$((ts/1000))" +%F)" = "2026-06-10" ] && echo "$f"
done
```

### Extract only user messages from a session

```bash
jq -r 'select(.role == "user") | .content[]? | select(.type == "text") | .text' <session>.jsonl
```

### Extract only assistant messages from a session

```bash
jq -r 'select(.role == "assistant") | .content[]? | select(.type == "text") | .text' <session>.jsonl
```

### Search all sessions by keyword

```bash
grep -li "キーワード" /sessions/*/*.jsonl
# To view only the body of matched lines
grep -h "キーワード" /sessions/*/*.jsonl | jq -r '.content[]?.text? // empty'
```

### Count tool usage

```bash
jq -r 'select(.role == "assistant") | .content[]? | select(.type == "toolCall") | .name' <session>.jsonl \
  | sort | uniq -c | sort -rn
```

### Summarize a session (message count and start/end times)

```bash
jq -s '{
  messages: length,
  user: ([.[] | select(.role == "user")] | length),
  assistant: ([.[] | select(.role == "assistant")] | length),
  first: (.[0].timestamp / 1000 | gmtime | strftime("%Y-%m-%dT%H:%M:%SZ")),
  last: (.[-1].timestamp / 1000 | gmtime | strftime("%Y-%m-%dT%H:%M:%SZ"))
}' <session>.jsonl
```

### Aggregate tokens and cost

```bash
jq -s '[.[] | select(.role == "assistant") | .usage.totalTokens // 0] | add' <session>.jsonl
```

## Notes

- Session files can be large. First check the timestamp with `head -1` and narrow the candidates; read the full contents only after narrowing the target.
- Some lines may have no `content` (for example, a `toolResult` with only `details`), so append `?`, as in `.content[]?`, to absorb empty arrays or nulls.
- Summarize search results in your answer; do not paste large amounts of the raw logs.
