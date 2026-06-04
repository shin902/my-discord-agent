# cron thread モード → poller 経由 設計メモ（コードあり版）

## 解決する問題

### 問題A: tick 全体のブロック

thread モードはエージェントの応答が返るまで tick 全体が止まる。`* * * * *` のジョブが実際には数分に1回しか動かない。

### 問題B: サンドボックスタイムアウト

エージェント起動直後からタイムアウトタイマーが始まる（現状10分）。ローカルLLM など同時処理数=1 の環境で複数ジョブが並列起動すると、後のジョブはキュー待ち時間もタイムアウトに含まれて失敗しうる。

---

## 採用方針

### 問題A の解消

cron の tick はキューへの書き込みだけ行って即終了する。スレッド作成・AI応答の取得・Discord への投稿はすべて poller 側が担う。

```
変更前:
  cron tick → sendMessage（await）→ thread.send

変更後:
  cron tick → appendInbox → 即終了
                    ↓
               poller → スレッド作成 → sendMessage → thread.send
```

### 問題B の解消

ロック粒度の変更（`serial` / `parallel-session` の切り替え。並列処理、直列処理を変更可能にする実装）は別スペックで扱う。該当スペック → [poller-dispatch-mode.md](docs/spec/poller-dispatch-mode.md)

---

## 変更内容

### 1. `InboxMessage` に cron-thread フィールドを追加（`queue/inbox.ts`）

```typescript
export interface InboxMessage {
  // ... 既存フィールド
  cronThread?: true;   // cron-thread トリガー
  cronJobId?: string;  // スレッド名生成用（cron-${jobId}-${dateSuffix}）
}
```

`channelId`: 親チャンネルID（スレッド作成先）  
`sessionId`: tick 時点では未確定。poller がスレッド作成後に `thread.id` で sendMessage を呼ぶため placeholder  
`content`: cron プロンプト

### 2. cron runner の thread モード変更（`cron/runner.ts`）

```typescript
// 変更前
const thread = await channel.threads.create({ name: `cron-...` });
const result = await sendMessage(groupName, thread.id, prompt);
if (result) {
  for (const chunk of splitMessage(result)) {
    await thread.send(chunk);
  }
}

// 変更後
await appendInbox({
  channelId,
  groupName,
  sessionId: `cron-${job.id}`,  // placeholder
  content: prompt,
  timestamp,
  cronThread: true,
  cronJobId: job.id,
});
```

### 3. poller の変更（`queue/poller.ts`）

typing indicator は cron-thread では不要なため、`startTypingLoop` より前で分岐する：

```typescript
export async function processMessage(msg: InboxMessage): Promise<void> {
  // cron-thread は typing indicator 不要のため先頭で分岐
  if (msg.cronThread && msg.cronJobId) {
    const channel = await client.channels.fetch(msg.channelId);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement)
    ) {
      console.error("[poller] cron-thread: チャンネルがスレッドをサポートしていません", msg.channelId);
      return;
    }
    // new Date() ではなく msg.timestamp を使う。
    // poller の処理遅延でスレッド名の時刻がずれるのを防ぐため、
    // cron が実際に起動した時刻（キュー投入時刻）を使う。
    const dateSuffix = new Date(msg.timestamp)
      .toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" })
      .slice(0, 16)
      .replace(" ", "-")
      .replace(":", "-");
    const suffix = `-${dateSuffix}`;
    const maxIdLen = 100 - "cron-".length - suffix.length;
    const truncatedId = msg.cronJobId.slice(0, maxIdLen);
    const thread = await channel.threads.create({
      name: `cron-${truncatedId}${suffix}`,
    });
    const response = await sendMessage(msg.groupName, thread.id, msg.content);
    if (response) {
      for (const chunk of splitMessage(response)) {
        await thread.send(chunk);
      }
    }
    return;
  }

  // 以降は通常フロー（typing indicator あり）
  const stopTyping = startTypingLoop(msg.channelId);
  // ...
}
```

---

## セッション継続性

poller がスレッドを作成した時点のスレッドIDがそのままセッションIDになる。`data/sessions/{group}/{thread.id}.jsonl` が生成され、ユーザーがスレッドに返信すると同じセッションIDで会話履歴が引き継がれる。

---

## 変更ファイルまとめ

| ファイル | 変更内容 |
|---|---|
| `queue/inbox.ts` | `InboxMessage` に `cronThread`, `cronJobId` フィールド追加 |
| `cron/runner.ts` | thread モードを `appendInbox` に変更、`sendMessage` 直接呼び出しを削除 |
| `queue/poller.ts` | cron-thread 専用フローを追加（`startTypingLoop` より前に分岐） |
