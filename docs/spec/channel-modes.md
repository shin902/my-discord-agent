# チャンネルモード

Channel の `sessionMode` はDiscord channel/threadをsessionへ対応付ける方法を表す。設定変更は再起動後に反映される。

## `sessionMode`

| 値 | 親チャンネルへの反応 | スレッド内への反応 |
|---|---|---|
| `shared` | 全メッセージに反応 | — |
| `thread` | 無視（メンションも含む） | 全メッセージに反応 |
| `auto-thread` | 任意のメッセージでスレッドを自動作成 | 全メッセージに反応 |

上表は `appendUserOnly` が未指定 / `false` の場合。`requiredMention: true` を指定したチャンネルでは、この表の「反応する」通常メッセージのうち、現在のDiscord Botへのメンションを含むものだけを処理する。スレッドでは親チャンネルの設定を参照するため、親チャンネルとその配下スレッドに同じ `requiredMention` ポリシーが適用される。

Slash command は通常メッセージの取り込み経路を通らないため、`requiredMention` の対象外。現在の `/bot` と、将来追加する `/new` などのコマンドもメンション不要で利用できる設計とする。

---

## `appendUserOnly`

任意boolean。未指定 / `false` は既存挙動。`true` は **`sessionMode: shared` 限定**で、`thread` / `auto-thread` / `email-mode` との併用は起動時config error。

```json
{ "channelId": "...", "sessionMode": "shared", "appendUserOnly": true }
```

担当Botが受信した設定shared channel自身のlive human `MessageCreate`（Default / Reply）を、`requiredMention` に関係なくchannel IDのcanonical sessionへuser entryとしてappendして終了する。本文・添付名/URL・timestamp・既存Discord source provenanceを保持する。その入力についてqueue、Agent/provider/tool実行、response/progress/placeholder、thread作成は発生しない。bot/Webhook/system、child thread、backfillは対象外。

同一channelのlive appendだけ到着順に保存し、source IDで重複排除する。保存失敗はhost logに残し、応答・replay復旧はしない。

session-wide modeではない。cron、`/skill`、`/bot`、既存queueなど他経路は従来どおりで、同じsessionのassistant / toolResult / custom entryも許容する。

`false` に戻して再起動すれば同じsessionを通常Agentとして再利用できる。contextFilesは既存のgeneric bootstrap判定（Agent execution evidenceの有無）に従う。専用初期化stateは持たない。

有効化した起動時に当該channelの既存Discord cursor行を削除し、有効中はbackfillもlive cursor更新もしない。normal復帰時は既存の初回起動処理で現在tipへseedするため、有効期間の保存済みmessageも停止中のmessageもAgent jobとして再生しない。seed以前の履歴は遡らず、それ以後は通常のbackfillに戻る。

---

## `thread` モードの注意点

Discord でスレッドを手動作成すると `ThreadCreated` という特殊なメッセージタイプが投稿される。
これは通常メッセージと区別がつかないため、`message.type === MessageType.ThreadCreated` を明示的にフィルタする必要がある。

---

## bot/Webhook投稿の扱い

`message.author.bot === true` のメッセージ(Webhook経由の投稿を含む)は、デフォルトでは無視される。

チャンネル設定の `allowedWebhookIds`(`string[]`、任意)に Webhook ID を登録すると、その Webhook からの投稿のみ例外的に処理対象になる。外部Webhook連携を `auto-thread` モードと組み合わせる場合に使う。

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

`requiredMention: true` の場合は上記の各通常メッセージについてメンション条件も満たす必要がある。

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

`requiredMention` で mention-only は扱えるようになった。将来、正規表現など別のengagement policyが実際に必要になった場合だけ、これを一般化する候補として `engageMode` を残す。

| 値 | 動作 |
|---|---|
| `mention` | ボットへのメンション時のみ反応（現状は `requiredMention: true` で表現可能） |
| `always` | チャンネルの全メッセージに反応（現行デフォルト） |
| `pattern` | `engagePattern` の正規表現にマッチしたメッセージに反応 |

> 参考: `docs/clone/nanoclaw/src/types.ts` の `EngageMode`
> 参考: `docs/clone/VRC-AI-Bot/implementation/src/runtime/chat/chat-engagement-policy.ts`
