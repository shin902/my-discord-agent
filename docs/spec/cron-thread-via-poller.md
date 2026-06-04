# cron thread モード → poller 経由 設計メモ

## 問題

### 問題A: tick 全体のブロック

`thread` モードは `sendMessage()` を `await` するため、エージェントが応答するまで tick 全体がブロックされる。`_isRunning` フラグにより次の tick はスキップされ、`* * * * *` のジョブが実際には数分に1回しか動かない。

### 問題B: サンドボックスタイムアウト

`sendMessage()` は `spawn()` 直後からタイムアウトタイマーが始まる（現状10分）。ローカルLLM の同時処理数=1 環境で複数ジョブが並列起動すると、後のジョブはキュー待ち時間も含めてタイムアウトに引っかかりうる。

---

## 採用方針

### 問題A の解消: cron thread を poller 経由に統一

`thread` モードでも `appendInbox` 経由にして tick をノンブロッキングにする。スレッド作成・`sendMessage` 呼び出し・Discord 投稿はすべて poller 側で行う。

```
変更前:
  cron tick → sendMessage（await）→ thread.send

変更後:
  cron tick → appendInbox → 即終了
                    ↓
               poller → スレッド作成 → sendMessage → thread.send
```

`sendMessage` は JSONL への書き込みとレスポンス返却のみ行う。Discord への投稿は poller が明示的に `thread.send(response)` で行う。

### 問題B の解消: poller を全直列化

`channelChain` をチャンネル単位からグローバル単一キューに変更する。ローカルLLM は同時処理数=1 のため、Node.js 側でも直列にするのが最もシンプル。

```typescript
// 変更前: チャンネル単位
const channelChain = new Map<string, Promise<void>>();

// 変更後: グローバル直列キュー
let globalChain = Promise.resolve();
```

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
`sessionId`: tick 時点では未確定。poller が `thread.id` を使って `sendMessage` を呼ぶため実質未使用  
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
  channelId,         // 親チャンネルID
  groupName,
  sessionId: `cron-${job.id}`,  // placeholder
  content: prompt,
  timestamp,
  cronThread: true,
  cronJobId: job.id,
});
```

### 3. poller の変更（`queue/poller.ts`）

#### 直列化

```typescript
// 変更前: チャンネル単位ロック
const channelChain = new Map<string, Promise<void>>();
dispatchWithChannelLock(msg.channelId, () => processMessage(msg));

// 変更後: グローバル直列キュー
let globalChain = Promise.resolve();
function dispatch(fn: () => Promise<void>): void {
  globalChain = globalChain.then(fn).catch((err) => {
    console.error("[poller] 予期せぬエラー:", err);
  });
}
```

#### cron-thread 処理の追加

`processMessage` で `cronThread` フラグを検出したら専用フローへ：

```typescript
if (msg.cronThread && msg.cronJobId) {
  const channel = await client.channels.fetch(msg.channelId);
  // チャンネル型バリデーション（GuildText / GuildAnnouncement のみ）
  const dateSuffix = new Date()
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
```

typing indicator は cron-thread では不要なためスキップ。

---

## セッション継続性

poller が `sendMessage(groupName, thread.id, prompt)` を呼ぶことで `data/sessions/{group}/{thread.id}.jsonl` が生成される。その後ユーザーがスレッドに返信すると handler.ts が `sessionId = thread.id` で `appendInbox` し、会話履歴が引き継がれる。

---

## 変更ファイルまとめ

| ファイル | 変更内容 |
|---|---|
| `queue/inbox.ts` | `InboxMessage` に `cronThread`, `cronJobId` フィールド追加 |
| `cron/runner.ts` | thread モードを `appendInbox` に変更、`sendMessage` 直接呼び出しを削除 |
| `queue/poller.ts` | グローバル直列キュー化 + cron-thread 処理追加 |
