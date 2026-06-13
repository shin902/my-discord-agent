---
name: session-logs
description: "自分自身の過去の会話ログ(セッションJSONL)をjq/grepで検索・集計するスキル。「前に話したこと覚えてる?」「先週何の話した?」など、MEMORY.mdに無い過去の文脈を聞かれたら使う。"
---

# session-logs

このグループの過去のセッション(会話履歴)を、jq/grep で検索・集計する。

## いつ使うか

- ユーザーが過去の会話・以前のやり取りについて聞いてきたが、`MEMORY.md` に該当する記載がない
- 「先週」「前に」「過去ログ」「何回くらいやり取りした?」のような問いかけ
- 自分の発言・ツール使用履歴を振り返る必要があるとき

## ログの場所

`/sessions/*/*.jsonl`

- 1ファイル = 1セッション(Discordのチャンネル/スレッドID = ファイル名)
- 各行 = 1メッセージ(JSON、1行1オブジェクト)
- 自分のグループのディレクトリだけがマウントされているため、他グループのログは見えない

## 各行の構造

ラップ構造はなく、メッセージオブジェクトが直接1行になっている。

```json
{"role": "user", "content": [{"type": "text", "text": "..."}], "timestamp": 1780531201389}
```

- `role`: `"user"` | `"assistant"` | `"toolResult"`
- `content[]`: `type` が `"text"`(本文) または `"toolCall"`(ツール呼び出し、`name`/`arguments` を持つ)
- `timestamp`: Unixエポックミリ秒(ISO文字列ではない)
- `assistant` の行には `usage.cost.total` / `usage.totalTokens` / `model` / `provider` / `stopReason` も入る
- `toolResult` の行は `toolName` / `toolCallId` / `isError` を持ち、`content[]` に結果テキストが入る

## よく使うクエリ

### セッション一覧(日付・サイズ)

```bash
for f in /sessions/*/*.jsonl; do
  ts=$(head -1 "$f" | jq -r '.timestamp')
  date=$(TZ=Asia/Tokyo date -d "@$((ts/1000))" +%F)
  size=$(ls -lh "$f" | awk '{print $5}')
  echo "$date $size $f"
done | sort -r
```

### 特定の日のセッションを探す

```bash
for f in /sessions/*/*.jsonl; do
  ts=$(head -1 "$f" | jq -r '.timestamp')
  [ "$(TZ=Asia/Tokyo date -d "@$((ts/1000))" +%F)" = "2026-06-10" ] && echo "$f"
done
```

### あるセッションのユーザー発言だけ抜き出す

```bash
jq -r 'select(.role == "user") | .content[]? | select(.type == "text") | .text' <session>.jsonl
```

### あるセッションのassistant発言だけ抜き出す

```bash
jq -r 'select(.role == "assistant") | .content[]? | select(.type == "text") | .text' <session>.jsonl
```

### キーワードで全セッションを横断検索

```bash
grep -li "キーワード" /sessions/*/*.jsonl
# マッチした行の本文だけ見たい場合
grep -h "キーワード" /sessions/*/*.jsonl | jq -r '.content[]?.text? // empty'
```

### ツール使用回数の集計

```bash
jq -r 'select(.role == "assistant") | .content[]? | select(.type == "toolCall") | .name' <session>.jsonl \
  | sort | uniq -c | sort -rn
```

### セッションの概要(メッセージ数・開始/終了時刻)

```bash
jq -s '{
  messages: length,
  user: ([.[] | select(.role == "user")] | length),
  assistant: ([.[] | select(.role == "assistant")] | length),
  first: (.[0].timestamp / 1000 | gmtime | strftime("%Y-%m-%dT%H:%M:%SZ")),
  last: (.[-1].timestamp / 1000 | gmtime | strftime("%Y-%m-%dT%H:%M:%SZ"))
}' <session>.jsonl
```

### トークン/コストの集計

```bash
jq -s '[.[] | select(.role == "assistant") | .usage.totalTokens // 0] | add' <session>.jsonl
```

## 注意

- セッションファイルは大きくなることがある。まず `head -1` でタイムスタンプを確認してから絞り込み、全文を読むのは対象を絞ったあとにする
- `content` が無い行(`toolResult` の `details` のみ等)もあるため、`.content[]?` のように `?` を付けて空配列/nullを吸収する
- 検索結果は要約して回答する。ログそのものを大量に貼り付けない
