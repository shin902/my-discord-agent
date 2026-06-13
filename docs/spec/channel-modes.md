# チャンネルモード

Channel が持つ `sessionMode` で動作が決まる。

## `sessionMode`

| 値 | 親チャンネルへの反応 | スレッド内への反応 |
|---|---|---|
| `shared` | 全メッセージに反応 | — |
| `thread` | 無視（メンションも含む） | 全メッセージに反応 |
| `auto-thread` | 任意のメッセージでスレッドを自動作成 | 全メッセージに反応 |

---

## `thread` モードの注意点

Discord でスレッドを手動作成すると `ThreadCreated` という特殊なメッセージタイプが投稿される。
これは通常メッセージと区別がつかないため、`message.type === MessageType.ThreadCreated` を明示的にフィルタする必要がある。

---

## bot/Webhook投稿の扱い

`message.author.bot === true` のメッセージ(Webhook経由の投稿を含む)は、デフォルトでは無視される。

チャンネル設定の `allowedWebhookIds`(`string[]`、任意)に Webhook ID を登録すると、その Webhook からの投稿のみ例外的に処理対象になる。feedcord等のRSS連携で `auto-thread` モードと組み合わせて使う(`.claude/skills/add-rss-feed/SKILL.md` 参照)。

```json
{
  "channelId": "...",
  "sessionMode": "auto-thread",
  "allowedWebhookIds": ["123456789012345678"]
}
```

Webhook IDは、Discordで発行されるWebhook URL `https://discord.com/api/webhooks/<WEBHOOK_ID>/<TOKEN>` の `<WEBHOOK_ID>` 部分。

---

## `auto-thread` の詳細

> 参考（URLのみに限定されてる）:
> - `docs/clone/VRC-AI-Bot/implementation/src/runtime/chat/chat-engagement-policy.ts`
> - `docs/clone/VRC-AI-Bot/implementation/src/domain/response-boundary.ts`
> - `docs/clone/VRC-AI-Bot/implementation/src/runtime/message/reply-dispatch-service.ts`
> - `docs/clone/VRC-AI-Bot/implementation/src/discord/message-utils.ts`

### フロー

```
1. 親チャンネルにメッセージが届く
     → スレッドを自動作成してそこに返信

2. そのスレッド内のメッセージが届く
     → 常に処理し、同じスレッド内で返信
```

### スレッド名の生成

URL の有無で名前を変える。

```
URL あり → "{hostname}-{messageId末尾6文字}"  例: "github-com-a1b2c3"
URL なし → "thread-{messageId末尾6文字}"
最大100文字
```

> 参考: `reply-dispatch-service.ts` の `buildKnowledgeThreadName()`

### URL の抽出

```typescript
// message-utils.ts
const URL_PATTERN = /https?:\/\/[^\s<>()]+/giu;
```

> 参考: `docs/clone/VRC-AI-Bot/implementation/src/discord/message-utils.ts` の `extractUrls()`

---

## 将来の実装候補

### `engageMode`

パブリックサーバーや複数用途のチャンネルで使う場合に必要になる可能性がある。現在はプライベートサーバー限定のため未実装。

| 値 | 動作 |
|---|---|
| `mention` | ボットへのメンション時のみ反応 |
| `always` | チャンネルの全メッセージに反応（現行の動作） |
| `pattern` | `engagePattern` の正規表現にマッチしたメッセージに反応 |

> 参考: `docs/clone/nanoclaw/src/types.ts` の `EngageMode`
> 参考: `docs/clone/VRC-AI-Bot/implementation/src/runtime/chat/chat-engagement-policy.ts`
