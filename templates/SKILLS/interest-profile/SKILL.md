---
name: interest-profile
description: "Generate and update a user interest profile from conversation history. Trigger on 「/interest-profile sync」, 「プロファイル更新」, 「興味プロファイル」, 「/interest-profile show」, or 「興味を見せて」."
---

# Interest profile generation skill

Analyze this group's Discord session database (`/sessions/{group}/sessions.sqlite`) and accumulate or update the user's interest profile in `INTERESTS.md` (the project root).

The sole responsibility of this skill is **to extract and accumulate interests from conversation history**.
As the user continues ordinary conversations with this agent on Discord, the profile grows automatically from that history. Asking about an article, researching a topic, or expressing an opinion—these everyday conversations become signals directly.

The session location and format follow the same assumptions as the [session-logs](../session-logs/SKILL.md) skill: each group has `/sessions/{group}/sessions.sqlite`, and unwrapped `{"role", "content", "timestamp"}` messages are stored in `session_entries.payload_json`. Incremental reads use each session's `sequence` cursor.

This skill has two modes:

- **sync mode**: Run on triggers such as 「sync」「更新」「プロファイル更新」 → run Sections 1–5.
- **show mode**: Run on triggers such as 「show」「見せて」「表示」 → run Section 6.

Data directory: `data/interests/`

---

## Important: autonomous execution rules

When run automatically by cron or `/loop`, follow these rules strictly:
- Never ask the user for confirmation or questions.
- Execute all processing autonomously and immediately.
- If an error occurs, record it in the log and continue processing.

---

## sync mode

### Section 1: Extract new user messages from conversation logs

Use the Python script to extract the new portion of the conversation logs.

```bash
python3 SKILLS/interest-profile/scripts/extract_interests.py \
  --state-file "data/interests/last-sync.json" \
  --state-out "data/interests/last-sync.json.pending" \
  --max-messages 500
```

**Note:**
- `--logs-dir` is optional. When omitted, inspect each group database at `/sessions/{group}/sessions.sqlite`. The pending state records the last scanned `session_entries.sequence` for each session.
- Do not update `last-sync.json` at this stage. Use `--state-out` only to write the "state to advance" to the pending file (`last-sync.json.pending`), then promote it atomically (commit) in Section 5 after all processing completes successfully. This preserves the transaction boundary, so the cursor does not advance if an intermediate step fails.

Consume the script's output (a JSON array). If zero messages are extracted, you may finish after performing only the Section 5 state update, since there are no new signals.

### Section 2: Load existing accumulated data (recent entries only)

Load **only the signals from the most recent 90 days** from `data/interests/interest-log.jsonl`. Do not read every line (the log grows without bound, and reading it all would expand the context indefinitely; because of time weighting, signals older than 30 days have little effect, so recent entries are sufficient).

Have the script output only recent entries, then read that output:

```bash
python3 SKILLS/interest-profile/scripts/extract_interests.py \
  --recent-log "data/interests/interest-log.jsonl" \
  --recent-days 90
```

This command writes to stdout only rows whose `ts` is within the most recent 90 days (and writes nothing if the file does not exist). Treat this as the accumulated historical data and combine it with the new signals to rebuild the profile. Do not delete the raw log; the full history remains in the file, while only the loaded range is narrowed.

### Section 3: Classify interest signals

Classify the new user messages extracted in Section 1.

#### 3a. Identify noise

Exclude the following as noise (do not record them in `interest-log.jsonl`):
- Pure operational instructions: 「最後に確認して」「チェックして」「コミットして」
- File operations: 「mkdir」「移動して」「削除して」
- Configuration changes: 「permissions」「bypass」「設定を変えて」
- Skill invocation alone: `/email check`, etc. (with no additional comment)
- Greetings and short replies: 「はい」「OK」「ありがとう」
- Cron-generated messages (the `メールID: ` prefix): `extract_interests.py` excludes these automatically, so do not treat them as interests here either.

#### 3b. Classify signals

Classify non-noise messages into the categories below. `intensity` represents the strength of interest indicated by that single message:

| category | Criteria | intensity |
|----------|---------|-----------|
| `question` | Questions such as 「〜とは？」「教えて」「どういうこと？」 | 1-2 |
| `deep-dive` | Three or more questions about the same topic in one session | 3 |
| `creation-intent` | An active intention to make or do something, such as 「作りたい」「試したい」「書きたい」「やってみたい」 | 3 |
| `topic-exploration` | An opinion about or comparison of a topic | 1-2 |
| `opinion` | An explicit statement of preference or evaluation | 2 |

#### 3c. Assign topics and keywords

Attach the following to each signal:
- **topic**: A concise topic name (in Japanese, no more than 20 characters).
- **keywords**: An array of matching keywords (lowercase English, 3–8 items).
- **raw_excerpt**: The first 200 characters of the original message (the `content` field supplied by the script is at most 2,000 characters, but record only its first 200).

JSON format for each signal (record one JSON object per line in `interest-log.jsonl`):

```json
{"ts": "<ISO8601>", "session_id": "<セッションID>", "source": "conversation", "category": "<カテゴリ>", "intensity": <1-3>, "topic": "<トピック名>", "keywords": ["..."], "raw_excerpt": "<先頭200文字>"}
```

### Section 4: Generate INTERESTS.md

Generate `INTERESTS.md` from the recent 90-day signals loaded in Section 2 plus the new signals from this run.

#### 4a. Calculate interest scores

Calculate each topic's "interest strength" with the formula below and use it to order the "current interests":

```
Topic score = Σ (intensity × time weight)   [sum all signals belonging to the topic]

Time weights:
  - Last 14 days : 1.0
  - 15–30 days : 0.5
  - More than 30 days old : 0.25
```

This sum naturally reflects two factors:
- **More recent interest carries more weight**: Time weighting prioritizes recent signals.
- **More questions and mentions indicate stronger interest**: Each repeated touch on the same topic adds a signal and raises its score. A topic explored three or more times in one session is also promoted to `deep-dive` (`intensity` 3), giving it a substantial boost.

Treat the highest-scoring topics as "current interests" and topics with scores sustained across time windows as "ongoing interests".

#### 4b. Writing style guidelines

Write INTERESTS.md in **natural-language prose**. Do not use a table.

Follow these principles:
- **Write a profile that conveys the person's character**: Make the person's interests and goals clear even to a first-time reader.
- **Be specific**: Include evidence of behavior—for example, write 「Anthropicのハーネス設計記事を精読し、木構造探索の挙動まで掘り下げて質問していた」 rather than just 「設計に関心がある」.
- **Keep it compact**: No more than 80 lines in total.
- **Prioritize information useful for decisions and deeper exploration**: You may omit mere operational interests (such as permission or cron configuration).

#### 4c. INTERESTS.md template

```markdown
---
last_updated: "{YYYY-MM-DD}"
signals_total: {総シグナル数}
---

# 興味プロファイル

## この人について

{ユーザーの基本的な人物像を2-3文で。関心の幅、姿勢（表面的ではなく本質を掘り下げるタイプ等）。}

## 今の関心（直近14日）

{4aのスコア上位から順に、自然な文章で記述する。各トピックについて：
- 何にどれくらい深く関心を持っているか
- どのような行動（質問、繰り返しの深掘り、比較検討、やりたいことの表明等）からそれがわかるか
- 関連する具体的なキーワードや固有名詞

段落ごとに1つの大きなテーマを扱い、太字で導入する。
重要度の低いものは簡潔に触れる程度でよい。}

## 継続的な関心

{14日より前から継続してスコアが付いている、この人の根っこにあるテーマを2-4個。
一過性の関心と区別して、長く向き合っているものを記述する。}

## 新規探索のヒント

{ユーザーの興味パターンから推測される「まだ直接触れていないが関連性の高い領域」を3-5個。
それぞれ1-2文で、なぜこの人に刺さりそうかの理由を添える。}
```

Save INTERESTS.md to `INTERESTS.md` (the project root).

### Section 5: Update state

After all processing completes successfully, perform the following **in this order**. **Keep this order** (reversing it creates a partial commit in which the cursor advances while new signals remain unrecorded):

1. Append the new signals to `data/interests/interest-log.jsonl` (one JSON object per line).
2. Promote the pending file (`last-sync.json.pending`) to the main file (commit):

```bash
python3 SKILLS/interest-profile/scripts/extract_interests.py \
  --state-file "data/interests/last-sync.json" \
  --commit "data/interests/last-sync.json.pending"
```

- This command reads the pending file, atomically replaces `last-sync.json` with `os.replace`, and then deletes the pending file.
- After a successful commit, no `.pending` file exists (it has been promoted). If `.pending` remains during the next sync, it is residue from the previous interruption; Section 1's `--state-out` unconditionally overwrites it, so it may be left alone.
- **Duplicate warning**: This order prevents the cursor from advancing while new signals are lost, but if execution is interrupted between steps 1 and 2, the next sync may extract the same messages again and record duplicate signals in `interest-log.jsonl` (the design accepts duplicates rather than dropped signals). Duplicates are counted twice in scores, so before appending, skip any signal whose `ts` + `raw_excerpt` matches an existing row.

3. Report completion:
```
興味プロファイルを更新しました。
- 新規メッセージ: {N}件分析
- 新規シグナル: {M}件検出
- 保存先: INTERESTS.md
```

---

## show mode

### Section 6: Display the profile

Read and display `INTERESTS.md` (the project root).

If the file does not exist, tell the user 「まだプロファイルが生成されていません。`/interest-profile sync` を実行してください」.
