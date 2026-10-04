# Session contextのclear / compact

raw履歴を削除せず、現在の会話に使うcontextだけを置き換える。保存先は既存のgroup別 `sessions.sqlite`。別archive DB、entryごとのactive/archiveフラグ、compact専用queueは持たない。

## 手動操作

- `/clear`: 旧sessionを一意な退避IDへrenameし、元のIDをfreshなsessionで置き換える。次のAgent実行でsystem prompt snapshot / time anchor / contextFiles / 初回Agent Memoryを通常どおり初期化する。
- `/compact`: 設定された会話モデルで固定templateの要約を生成し、旧sessionをrenameして、元のIDを初期snapshot + 要約 + recent verbatimで置き換える。圧縮対象の古い履歴がなければLLMを呼ばず変更しない。

shared channelは親channel、thread / auto-thread / email-modeはthread内で実行する。対象ownerはchannelのBot、未指定ならMain。メンションは不要。`/new` aliasは設けない。

コマンドは受付時に既存 `runtime.sqlite` の同じsession IDへenqueueする。実行中でも受付でき、先行jobの完了後に実行する。後着メッセージは後続jobとして待ち、compactを中断しない。完了結果は既存delivery経路で通知する。Discordの送信時刻でclear前後を振り分けず、queueの処理順を境界にする。

## Auto compact

通常のAgent jobの推論開始前にcontext使用量を判定し、閾値を超えていれば、そのjob内でcompactしてから今回の入力を処理する。別jobをenqueueして待つ方式やidle監視は使わない。同期Bot実行もRunnerの同じ前処理を使う。

AgentConfigの `compaction` はgroup / Bot profile / channel / cron jobに指定でき、他のAgentConfigと同じくfield単位の完全置換になる。

```json
"compaction": {
  "enabled": true,
  "threshold": 0.7,
  "keepRecentTokens": 20000
}
```

未指定時の既定値は上記。`enabled: false` はautoだけを無効にし、手動compactは利用可能。`threshold` は0より大きく1未満、`keepRecentTokens` は正の整数。recent予算はmodel context windowの20%を上限とする。

Piの実装を参考に、文字数/4と画像の固定コストでtoken数を概算する。判定にはsystem prompt・tool定義・今回の入力を含める。full contextでは直近の実測usageも使うが、checkpoint内のretained assistantの古いusageは圧縮後の使用量として扱わない。判定はjob開始時の1回だけであり、1つのtool loop内での肥大化や単体で巨大な入力を完全に防ぐものではない。

## 圧縮と保存

要約は `Goal / User Constraints / Current State / Important Facts / Decisions / Artifacts / Open Loops / Next Steps / Recall` の固定見出しを使う。ユーザーの条件・禁止事項・決定・正確なID/数値/URLを圧縮率より優先する。要約生成はtoolなしで行い、元の会話を継続しない。画像bytesは要約用JSONから除外する。要約中の `/steer` は受け付けず、`/stop` による中止は可能。

recentはuser turn単位で保持し、tool call/resultやskill invocationを分断しない。final-onlyのようにuser turnを持たない履歴ではassistant境界を使う。単一turnが大きすぎて安全な境界を取れない場合は、そのturn全体を要約する。繰り返しcompactは前回要約と新しく古くなった履歴から要約を更新する。

要約とrecentは1つのcheckpoint entryに保持する。recentを新たなraw user/assistant entryとして登録しないため、Memory exportへ同じ会話を二重登録しない。元のraw entry ID・source provenance・採用済み会話参照は退避先で維持する。旧履歴は `session-logs` からgroup内で検索でき、checkpointには退避先IDとownerが残る。退避側は通常会話の種別として保持してsession-cleanupの期限削除から外し、fresh側は元のsession種別を維持する。

LLM完了後のrenameとfresh側作成だけを短いSQLite transactionで確定する。要約失敗・abort・template不一致・圧縮量が減らない場合は切り替えない。通常のbootstrap初期化entryが追加される場合はある。queue retryには同じoperation IDを使い、切替成功後に再びclear/compactしない。auto compact後に本来の推論だけ失敗しても、retryは確定済みcheckpointから再開する。

## cron / final-only

同じsession IDを使うcronは通常入力と同じqueue順序で処理する。fresh / new-threadは別sessionであり、通常は圧縮する過去履歴がない。

final-onlyでは採用済み公開finalだけを要約対象とし、そのcheckpoint + recent公開final + 新たな公開finalを継続contextへ渡す。同じsessionを通常会話も使うため、final-onlyの圧縮ではfull側の会話をcheckpoint内に原文保持し、ユーザー制約やtool contextを失わせない。full側は後の通常実行時に必要なら別途圧縮する。full compactの要約をfinal-onlyへ流用しない。full compact時には公開finalのprojectionもcheckpointに保持して、後続final-only cronがprivateなuser/tool/途中応答を再注入せず履歴を継続できるようにする。clear後はこの公開projectionも引き継がない。

## appendUserOnlyの保護

`appendUserOnly: true` の設定channel IDを使うsessionでは、**手動clear/compactを拒否し、auto compactも実行しない**。channel設定やcron側の `compaction` overrideでこの保護を解除できない。Discord `/skill`・cron・同期Bot等、入口ではなく対象sessionで判定する。

通常の履歴追記・検索、既存 `/skill`・cronのAgent実行は維持する。この保護は蓄積履歴の置換を防ぐもので、Agent実行全体の禁止ではない。

## 導入

DB schema変更や既存履歴の一括変換は不要。同じcheckoutでHostとRunner imageを更新し、サービスを再起動する。新commandは別途 [Slash Command登録](../guides/discord-bot-setup.md#6-slash-command-の登録) を実行する。runtime起動時にはdeployしない。旧Runnerへ戻すとcheckpointを展開できないため、checkpoint作成後のrollbackでは対応するHost/Runnerを使うか、停止・backupの上で退避履歴を復元する必要がある。
