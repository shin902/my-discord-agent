# Agent Memory の記録対象と動作

この文書は、`my-discord-agent` の Agent Memory shadow capture が**実際に何を記録し、何を記録しないか**を説明する。設定項目は [`config.md`](./config.md)、内部の処理境界は [`spec/agent-memory-shadow-capture.md`](./spec/agent-memory-shadow-capture.md) を参照する。

## 最初に区別すること

「メモリへ追記する」処理には、次の2段階がある。

1. **L0 capture**: `my-discord-agent` が Discord の user/assistant 1往復を MemoryCore の `/v3/conversation/add` へ送る。
2. **長期記憶の抽出・統合**: MemoryCore がL0会話を分析し、L1/L2/L3へ昇格・統合する。

`my-discord-agent` は発言内容を見て「重要だから覚える」「雑談だから捨てる」とは判断しない。条件を満たした通常会話は、内容にかかわらず原則として1往復ずつL0 capture対象になる。何を長期記憶として残すかはMemoryCore側の責務である。

現在はshadow captureのみで、Agent Memoryからのrecall、通常回答へのcontext injection、明示的な「覚えて」「忘れて」の解釈は実装していない。

## L0 capture対象になる条件

最終的にMemoryCoreへ送られるには、次の条件をすべて満たす必要がある。

- `agentMemory.enabled` が `true`
- メッセージの所属groupが `agentMemory.eligibleGroups` に含まれる
- DiscordのMessage Typeが通常メッセージ（Default）またはReply
- 投稿者が人間ユーザーで、Discord user IDを取得できる
- ユーザー本文を `trim()` した結果が空でない
- 通常Agent実行が正常終了する
- Agentの最終回答が空でない
- cron、mail、RSS、Bot Task、Subagent、Agent Memory内部jobではない

`eligibleGroups` はprivacyを自動判定する仕組みではない。コードが確認するのはgroup名がリストに含まれるかだけであり、private/publicを推測しない。運用者がprivateと確認したgroupだけを列挙すること。

### 具体例

| 入力・実行経路 | L0 capture | 補足 |
|---|---:|---|
| eligible group内の人間による通常メッセージ | する | 内容の重要度は判定しない |
| eligible group内のReply | する | Reply元の本文は送信しない |
| `eligibleGroups` にないgroup | しない | private groupでも明示列挙が必要 |
| Botまたは許可Webhookからの投稿 | しない | 通常Agentが処理できるWebhookでもmemory対象外 |
| cron / mail / RSS | しない | 通常会話とは別経路として除外 |
| `/bot` のBot Task | しない | Bot Task Sessionの会話は現状対象外 |
| Subagentの依頼・結果 | しない | 親の通常最終回答だけが別条件で対象になり得る |
| `requiredMention` によりintakeで無視された投稿 | しない | 通常queueへ入らない |
| 添付あり・本文あり | する | 本文と最終回答だけを送る |
| 添付のみで本文が空 | しない | 添付内容・metadataはmemory payloadへ入らない |
| Agent実行が失敗、非ゼロ終了、または空回答 | しない | source job側の失敗処理だけを行う |
| 人間によるstartup backfill対象メッセージ | し得る | live/backfillをmemory eligibilityでは区別していない |

### `<NO_REPLY>` の扱い

通常会話の最終回答が非空で、独立行の `<NO_REPLY>` を含む場合、Discord配送は抑制される。一方、shadow job作成は配送抑制とは別に行われるため、そのuser/assistant 1往復はL0 capture対象になり得る。

## MemoryCoreへ送るデータ

HTTP bodyは次の形になる。

```json
{
  "session_id": "現在のDiscord session ID",
  "team_id": "agentMemory.teamId",
  "agent_id": "agentMemory.agentId",
  "user_id": "Discordの投稿者user ID",
  "messages": [
    {
      "role": "user",
      "content": "Discordメッセージ本文",
      "timestamp": "Discord投稿日時"
    },
    {
      "role": "assistant",
      "content": "Agentの最終回答",
      "timestamp": "回答完了時刻"
    }
  ]
}
```

- `user_id` は現在、Discord user IDをそのまま送る。hash化や別IDへの変換は行わない。
- `session_id` は現在のsession identityをそのまま送る。channel modeによってはDiscord channel IDまたはthread IDと同じ値になる。
- ユーザー本文はDiscordの `message.content` であり、URLやmention表現を含み得る。
- assistant側は途中経過ではなく、Agent実行が返した最終回答を送る。
- `x-tdai-service-id` headerには `agentMemory.serviceId` を設定する。
- `bearerTokenEnv` がある場合だけ、その環境変数の現在値をBearer tokenとして使う。

### 送信しないもの

次の情報はMemoryCoreのconversation payloadへ含めない。

- tool call、tool result、進捗通知
- system prompt、system prompt snapshot
- `MEMORY.md`、memory bootstrap snapshot
- model/providerやAgentConfig
- 添付ファイル本体、添付URL、ファイル名、MIME type
- Reply元メッセージの本文
- Discord message ID
- group名、routing channel ID、配送先channel IDを独立したfieldとして送ること

ただし前述のとおり、`session_id` 自体がDiscord channel/thread IDと一致する場合がある。group・channel・routing情報は、remote payloadとは別に、送信権限の再確認用metadataとしてローカルのruntime queueへ保存する。

## 記録されるタイミング

処理は次の順に進む。

```text
Discord message intake
  ↓
通常Agent実行
  ↓
最終回答の生成
  ↓
source result・Discord delivery・shadow jobをruntime.sqliteへcommit
  ↓
Discord delivery workerとshadow workerがそれぞれ処理
  ↓
shadow workerがMemoryCoreへPOST
```

shadow jobは、通常Agentの最終回答が完成した後に作る。source result、Discord配送のadmission、shadow jobのadmissionは同じruntime.sqlite transactionで確定する。

一方、Discordへの実配送とMemoryCoreへのHTTP送信は別workerで進むため、どちらが先に完了するかは保証しない。「ユーザーがDiscordで回答を読んだ後に必ずmemory処理が始まる」という順序ではない。

`my-discord-agent` が担当するのはL0送信までであり、MemoryCore内部のL1/L2/L3抽出をcronや優先度付きqueueで起動・停止する機能はない。MemoryCoreが使用するLLMのprovider、batch/逐次処理、同時実行数はMemoryCore側で管理する。通常回答と同時実行数1のローカルLLMを共有すると競合し得るため、現在の運用では別providerを推奨する。

## 3段階の対象確認

対象判定は一度だけではない。

### 1. Discord intake時

現在のconfigでeligibleなら、後続のmemory captureに必要なDiscord user IDを通常queue payloadへ保持する。ここでeligibleでなかったメッセージは、処理中にAgent Memoryを有効化しても原則として遡及captureされない。

configの読み込みやeligibility確認に失敗しても、通常のDiscord intakeは継続する。そのメッセージにはmemory用user IDを付けず、通常会話だけを処理する。

### 2. Agent回答完了時

configを再度読み、現在もeligibleで、ユーザー本文と最終回答が非空ならshadow jobを作る。準備処理に失敗した場合も、通常回答のcommitとDiscord配送は継続する。

### 3. MemoryCore送信直前

configとchannel→group mappingをfresh readし、shadow job作成時のadmissionと一致するか確認する。次の変更があった場合、待機中jobはMemoryCoreへ送らず、skipとして完了する。

- `enabled=false`
- groupを `eligibleGroups` から削除
- channelの所属groupを変更
- `baseUrl`、`serviceId`、`teamId`、`agentId` を変更
- `bearerTokenEnv` で参照する環境変数名を変更
- routing channel、destination channel、user、sessionのidentityが一致しない

`bearerTokenEnv` の**名前**はadmissionに含まれるが、token値そのものは保存しない。同じ環境変数名のtoken値をrotationした場合は、送信時の新しい値を使用する。

このrevalidationは未送信jobにだけ作用する。MemoryCoreがすでに受理したL0 conversationを、config変更だけで削除・更新することはない。

## 失敗・再試行・重複

MemoryCoreの障害は通常回答を失敗させない。

| 状況 | 通常回答 | shadow job |
|---|---|---|
| shadow準備時のconfig/read error | 継続 | 作成しない |
| MemoryCore成功 | 成功のまま | completed |
| network error / timeout | 成功のまま | 通常queueのretry対象 |
| HTTP/APIの408、429、5xx相当 | 成功のまま | retry対象 |
| その他の恒久的なAPI error | 成功のまま | dead-letter |
| `bearerTokenEnv` が設定済みだが値がない | 成功のまま | non-retryable dead-letter |
| config/group mappingが失効・変更済み | 成功のまま | remote送信せずskip/completed |
| process restart | 成功のまま | runtime.sqliteから未完了jobを再開可能 |

ローカルshadow admissionには `agent-memory-shadow:<source job ID>` のidempotency keyを使い、同じsource jobから複数のshadow jobを作りにくくしている。

ただしMemoryCoreのHTTP APIへclient指定のidempotency keyは送っていない。MemoryCoreが受理した後に応答だけ失われた場合や、受理後・ローカルcomplete前にprocessが停止した場合は再送され、remote側に重複L0ができる可能性がある。remote exactly-onceは保証しない。

## backfill・編集・削除の制約

### startup backfill

memory eligibilityはlive messageとbackfillを区別しない。startup backfillで人間の過去メッセージが通常Agent処理へ入った場合、新しく生成されたassistant回答との1往復がcapture対象になり得る。

### Discord messageの編集・削除

MessageCreate時の本文と、その実行で得たassistant回答をappendするだけである。後からDiscord上でuser messageやassistant messageを編集・削除しても、MemoryCoreへ自動同期しない。

### Reply

Reply message自体は対象だが、Reply元の本文・author・message IDは送らない。MemoryCoreへ渡るuser contentは現在のReply本文だけである。

### 明示的な「覚えない」「忘れて」

ユーザー本文の意味を `my-discord-agent` 側では解釈しない。そのため「これは覚えなくてよい」という通常メッセージも、他の条件を満たせばL0へ送られる。per-message opt-out、MemoryCore上の既存memory削除、Discord deleteとの連動は未実装である。

## ログの読み方

| ログ | 意味 |
|---|---|
| `shadow job admitted` | 通常回答完了後、shadow jobをローカルqueueへ保存した。MemoryCore受理済みという意味ではない |
| `shadow submission accepted` | MemoryCoreの`conversation/add`が成功応答を返し、ローカルjobを完了した |
| `shadow submission failed` | 今回のremote送信に失敗した。後続のretryまたはdead-letter判定を確認する |
| `shadow submission dead-lettered` | retry不能またはretry上限到達によりterminal failureになった |
| `shadow job skipped (disabled/revoked/rotated)` | 送信直前のconfig・group・admission確認が一致せず、remote送信せず完了した |
| `shadow job preparation failed` | 通常回答は成功したが、shadow jobを作れなかった |

`admitted` と `accepted` を混同しないこと。前者はローカル永続化、後者はremote成功を表す。

## 接続先の制約

- `http://` はliteral loopbackの `127.0.0.1` または `[::1]` だけを許可する。
- `localhost` は許可しない。
- loopback以外は `https://` が必須。
- URLへのusername/password、query、fragment埋め込みは禁止。
- HTTP redirectは追従せず失敗扱いにする。
- Bearer token自体はconfigやqueue payloadへ保存せず、`bearerTokenEnv` で指定した環境変数から送信時に読む。

## 現在実装していないこと

- Agent Memoryからのrecall、context injection
- per-messageの明示的opt-in / opt-out
- 「覚えて」「忘れて」のcommand semantics
- Discord edit/deleteとMemoryCoreの同期
- 添付ファイルやReply元本文のcapture
- startup backfillのmemory専用除外設定
- remote exactly-once / client idempotency key
- my-discord-agentからMemoryCore抽出を起動するbatch/cron mode
- 通常会話を優先する共通LLM priority broker
- MemoryCoreへ送信済みデータの削除・retention操作
