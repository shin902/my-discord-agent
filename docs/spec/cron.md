# cron 設計メモ

## 概要

定期実行ジョブの基盤。1分ごとに有効なジョブをチェックし、条件を満たせばエージェントへ投げる。

---

## ファイル構成

```
config/cron.json           # ジョブ定義（省略可。トップレベルは配列）
src/cron/
  runner.ts                # 1分ごとのスケジューラ（薄い実行基盤）
  jobs/
    mail.ts                # メール固有ジョブ（TSバインド方式）
    *.ts                   # 将来追加するジョブ
data/cron/
  state.json               # 各ジョブの lastRun を記録（重複実行防止）
```

---

## ジョブ定義（config/cron.json）

### 通常ジョブ（JSONだけで完結）

```json
[
  {
    "id": "daily-report",
    "schedule": "0 9 * * *",
    "groupName": "my-group",
    "botId": "research",
    "prompt": "昨日のログを分析して日次レポートを作成してください",
    "channelId": "12345",
    "deliveryMode": "new-thread",
    "historyMode": "full"
  }
]
```

上の `research` は `config/bots.json` で `group: "my-group"` として定義する。Mainで実行する場合は `botId` を省略する。

### カスタムジョブ（TSファイルをバインド）

```json
[
  {
    "id": "mail-check",
    "schedule": "*/30 * * * *",
    "groupName": "email",
    "channelId": "12345",
    "deliveryMode": "direct",
    "historyMode": "fresh",
    "handler": "jobs/mail.ts"
  }
]
```

`handler` があるジョブは `prompt`・`channelId`・`deliveryMode`・`historyMode` を省略可能。省略しない場合は `CronContext` 経由でハンドラーに渡される（Mailは `direct` + `fresh` に固定）。

---

## フィールド定義

| フィールド | 必須 | 型 | 説明 |
|-----------|------|-----|------|
| `id` | ✓ | string | ジョブID（一意）。空文字・空白のみは起動時の設定検証で拒否する。有効なIDはtrim・改名しない |
| `schedule` | ✓ | string | cron式 `"0 9 * * *"`、インターバル `"30m"` `"1h"`、または宣言型prompt job専用の `"@startup"` |
| `groupName` | handler なし時必須 / handler あり時オプション | string | エージェントグループ名。handler ありジョブでも記載すれば `CronContext.groupName` 経由で参照できる |
| `botId` | オプション | string | 同じgroupに所属するAgent Bot profile ID。未指定はMain。指定時はhandlerでもgroupName必須 |
| `prompt` | handler なし時必須 | string | エージェントへのプロンプト |
| `channelId` | handler なし時必須 | string | 送信先 Discord チャンネル ID |
| `deliveryMode` | handler なし時必須 | `"direct"` \| `"new-thread"` \| `"item-thread"` | Discordへの投稿方法（後述） |
| `historyMode` | handler なし時必須 | `"full"` \| `"final-only"` \| `"fresh"` | 過去の履歴をどう引き継ぐか（後述） |
| `noReply` | オプション | boolean | `true`なら、このリクエストのsystem promptへ通知不要時に独立行 `<NO_REPLY>` を返す指示を追加。既定値は`false` |
| `mode` | オプション | `"to-channel"` \| `"to-thread"` | 旧設定との後方互換用。新規設定では使用しない |
| `handler` | オプション | string | カスタムロジックの TS ファイルパス（`src/cron/` からの相対パス。`../` などパストラバーサルは正規表現で弾く） |
| `model` | オプション | object | AgentConfig。`provider` / `modelId` / `thinkingLevel`。group/channelのmodelオブジェクトを完全置換 |
| `tools` | オプション | string[] | AgentConfig。エージェントに渡すツール名。親の配列を完全置換 |
| `approvalRequiredTools` | オプション | string[] | AgentConfig。effective native `tools` とeffective `toolSets` の和集合に含まれる既知host/runtime capabilityのうちapprovalを挟むtool名。全layerで未指定のためeffective configに設定がない場合、またはeffective `[]` の場合はapprovalなし。jobで未指定なら親を継承し、`[]` は明示解除。親の配列を完全置換 |
| `skills` | オプション | string[] | AgentConfig。説明・workflowの公開だけを制御し、capabilityは付与しない。明示したスキル名で親の指定を完全置換 |
| `toolSets` | オプション | string[] | AgentConfig。trusted capability permission set（agent-reach/arxiv-search/arxiv-survey/last30days/web/github/mail/calendar/weather）。未指定ならgroupを継承し、指定配列は完全置換、`[]`で解除。未知名と `"*"` は設定エラー |
| `mounts` | オプション | object[] | AgentConfig。コンテナへの追加マウント。親のmounts配列を完全置換 |
| `contextFiles` | オプション | object[] | AgentConfig。workspace相対ファイルをsession初回のuser roleへ注入する。親の配列を完全置換し、`[]`で無効化 |
| `settings` | オプション | unknown | ハンドラー固有の設定値置き場。中身は検証せずそのまま `CronContext.settings` 経由でハンドラーに渡す。ハンドラー側で必要な型にキャスト、または自前で Zod パースして使う |

handlerが設定されてる場合、JSONの全フィールドは `CronContext` に詰めてハンドラーに渡す。"handler なし時必須" フィールドはhandlerありの場合オプション扱いになるが、記載すればハンドラーから参照できる。

通常のDiscord会話におけるAgentConfigの解決順は `group → Bot profile（指定時） → channel`、cron jobにおける解決順は `group → Bot profile（botId指定時） → cron job` である。cronの `channelId` は配送先を指定するためだけに使われ、通常チャンネルIDでも既存スレッドIDでも配送先channelのAgentConfigは継承しない。未指定フィールドは親を継承し、`approvalRequiredTools` のjobでの未指定も同様に親を継承する。`[]` は明示解除であり、指定フィールドはモデルオブジェクトや配列を含めて完全置換する。`allowMention` と `toolLogArgs` はgroup限定の配送・観測設定であり、channel/cronのAgentConfig override対象ではない。cronのAgentConfigは信頼済みの静的設定からのみ投入する。

### Bot owner

`botId` は既存のcached Bot Registryで解決し、存在と `bot.group === cron.groupName` を検証する。不一致はエラーとし、groupの暗黙補正やBot設定のhot reloadは行わない。設定変更には再起動が必要。

宣言型jobと `enqueueCronInbox()` を使うhandlerが対象。queueへ直接書き込むhandlerを暗黙にBot実行へ変換しない。配送先channelのBot指定も継承しない。Bot instructionsはchannel Botと同じ初回snapshot・既存snapshot再利用の規則で普通のowner-scoped sessionへ保存し、Bot Task Sessionは作らない。`sessions.agent_id` に選択Botを保持するが、Memory consolidationやeligibilityは変更しない。

### settings の例

```json
{
  "id": "some-job",
  "schedule": "*/30 * * * *",
  "handler": "jobs/some-job.ts",
  "settings": { "maxResults": 10, "labelFilter": "INBOX" }
}
```

### 使い捨てcron sessionのcleanup

`jobs/session-cleanup.ts` を毎日1回実行する設定例は `config/cron.example.json` を参照。LLMを起動せず、全groupのsession DBから `kind=cron-per-run` かつ最終更新から7日を超えたsessionを削除します。`session_entries` はcascadeで削除されます。cleanupはownerに限定せず `kind` と期限で選別します（作成ownerは `botId`、未指定なら `main`）。通常会話、`full` / `final-only` cron、タグのない旧cron sessionは対象外です。保存済み種別 `cron-per-run` は `fresh` のcleanup用タグとして維持します。削除したDBは `VACUUM` でファイル容量も回収します。圧縮に失敗した場合は警告を出し、他groupの削除を継続します。空きページが残っているDBは次回に圧縮を再試行します。圧縮中はDBの書き込みが待機するため、低負荷の時間帯に実行してください。削除した履歴は再参照・Memoryへの再exportができません。運用時はこのhandlerをcron設定に追加してください。

### deliveryMode / historyMode

投稿方法と過去履歴の引き継ぎ方は独立して指定する。すべての組み合わせで `appendInbox()` 経由の非同期処理となり、cron tick はadmission後にハンドラー完了やキューへの追加を待たず返る。

| フィールド | 値 | 動作 |
|---|---|---|
| `deliveryMode` | `direct` | `channelId` が指すチャンネルまたは既存スレッドへ直接投稿する |
| `deliveryMode` | `new-thread` | `channelId` を親チャンネルとして毎回新規スレッドを作成し、そこへ投稿する |
| `deliveryMode` | `item-thread` | 一時sessionでAIを実行し、応答が存在する場合だけ親メッセージを投稿して、そのmessage IDへsessionを昇格してから1項目用スレッドを作成する |
| `historyMode` | `full` | 配信先sessionを継続し、full historyを使う。実際の投稿先チャンネルまたはスレッドIDをセッションIDとして使う |
| `historyMode` | `final-only` | `full` と同じセッションIDを使い、過去公開finalだけを継続contextへ渡す |
| `historyMode` | `fresh` | 実行ごとに新しいsessionを使い、過去runの履歴を引き継がない |

代表的な組み合わせ:

| 設定 | 用途 |
|---|---|
| `direct` + `fresh` | 同じチャンネルまたは既存スレッドへ投稿するが、実行ごとの履歴は分離する |
| `direct` + `full` | 投稿先単位で履歴を継続する |
| `new-thread` + `full` | 毎回新規スレッドを作り、その後のユーザー返信でも履歴を継続する |
| `new-thread` + `fresh` | 毎回新規スレッドを作るが、cron実行の履歴はユーザー返信へ引き継がない |
| `item-thread` + `full` | 1項目ごとに一時sessionでAIを実行し、通常応答がある場合だけ親メッセージと独立スレッドを作り、そのthread IDへsessionを昇格する。`item-thread` は `full` または `final-only` 必須 |

`direct` / `new-thread` / `item-thread` は `final-only` とも組み合わせられる。

item-thread昇格・rollbackは保存済みjobのownerを維持する。同じgroup・Bot owner・投稿先を使うchannel会話と `full` / `final-only` cronは保存先sessionを共有し、異なるownerの履歴は分離する。

応答中にtrim後が完全一致する独立行 `<NO_REPLY>` があれば、通常会話、および`direct`/`new-thread`/`item-thread` cronは正常完了してDiscord deliveryを作らない。inlineの言及は通常どおり配送する。cronの`noReply: true`はこのプロトコルをsystem promptで案内するだけで、判定自体は常時有効である。`item-thread`はDiscord状態を応答後まで作らないため、NO_REPLY時は親メッセージもthreadも作成しない。Mail/RSS sourceは無配信でも正常にACK/finalizeする。Mail ACK失敗時は未読のまま次回cronで再取得し、RSS settle失敗時はclaimを解放して次回cronで再取得する。`new-thread` + `full` はthread IDをAIセッションに使うため実行前にスレッドを作成し、NO_REPLY時も投稿のないスレッドが残る。

旧 `mode` は後方互換のため受理する。`to-channel` は `direct` + `fresh`、`to-thread` は `new-thread` + `full` に変換する。旧 `mode` と新しい2フィールドは同時指定できない。item-threadを使うhandler付きジョブは `CronContext.deliveryMode` に `item-thread` を指定する。`mail.ts` はMail専用のroute keyを付け、常に `direct` + `fresh` でenqueueする。Discord deliveryはMail専用のthread mappingを使用する。

### final-only historyMode

cron jobに `"historyMode": "final-only"` を明示した場合、次runのLLM contextを初期context snapshot・同じ `(group, agent_id, sessionId)` の過去runの採用済み公開final・今回の入力に絞る。session IDは `full` と同じ規則を使う。`full` は過去履歴全体を引き継ぎ、`fresh` は実行ごとに新しいsessionを使う。どちらもfinal-only projectionは行わず、同じrunのretryではraw historyを使う。未対応の値は起動時config errorになる。

```json
{
  "id": "github-check",
  "schedule": "*/10 * * * *",
  "groupName": "main",
  "channelId": "123",
  "deliveryMode": "direct",
  "historyMode": "final-only",
  "prompt": "未処理のGitHub PRを確認してください"
}
```

Mainとjobの `botId` で選択されたBotは共通contractを使う。jobのhistoryModeは `enqueueCronInbox()` でqueue入力に保存し、pollerは保存済みmodeを使う。設定変更は再起動後の新規enqueueに適用し、受付済みqueueのpolicyは変えない。channel・group・Bot profileにはこの設定を設けず、通常のDiscord入力や同期 `bot run/resume`・`/bot` Taskには継承しない。handlerがenqueue時に `fresh` を選んだ場合は過去runの履歴を引き継がず、final-only projectionは行わない。既存のMail handlerは常に `fresh` を使うため対象外。

初版は採用順に過去finalを全件引き継ぎ、件数/token上限やLLMによる要約は設けない。finalは成功結果commit時のassistant entry参照で識別し、非空textの `stop` / `length` 応答だけを使う。tool call/result、途中assistant、過去user/event、skill invocation、steering instructionは自動再注入しない。system prompt・contextFiles・保存済み初回Agent Memoryなどの初期snapshotは維持し、今回のskill invocationやsteerは通常どおり届く。

失敗・キャンセル・finalなし・採用されなかったretryは除外する。`<NO_REPLY>` / `discordOutput: "none"` など配信を抑制した結果も含めない。「公開」は配送対象の成功結果として採用された時点を意味し、Discord配送完了は待たない。raw trajectoryは削除・圧縮・書き換えず保持する。識別参照や配信可否のmetadataがない旧履歴は推測して採用しない。[保存・移行](../storage.md#session-trajectory)も参照。

---

## TSバインドジョブのインターフェース

```typescript
// src/cron/jobs/mail.ts
export default async function handler(ctx: CronContext): Promise<void> {
  // ctx に client, appendInbox などが入る
}
```

`CronContext` に含めるもの:
- Discord `client`
- `appendInbox`
- ジョブ定義の全フィールド（`id`, `schedule`, `groupName?`, `prompt?`, `channelId?`, `deliveryMode?`, `historyMode?`, `noReply?`, `mode?`, `handler?`, `settings?`）を展開して渡す

複数項目を扱うhandlerも、各項目を `enqueueCronInbox()` で登録する。`item-thread` ジョブは投入ごとに一時sessionを作り、AIが通常応答を返した後、delivery workerが親メッセージを投稿し、そのmessage/thread IDへsession DB上のidentityとruntime identityを昇格してからthreadを作成する。item-threadのsource照合や完了ACKはcron基盤では行わず、必要ならhandler側で扱う。

---

## スケジュール形式

- **cron式**: `"0 9 * * *"` — 分・時・日・月・曜日。標準的な cron 記法
- **インターバル**: `"30m"` `"1h"` `"2h"` — 起動からの経過時間ベース
- **起動時**: `"@startup"` — handlerなしの宣言型prompt jobを、Discord loginと起動時backfillの完了後、通常poller開始前に1回だけqueueへ投入する。通常のcron tickでは実行しない

**重複実行防止**: `@startup` を除き、`data/cron/state.json` に各ジョブの `lastRun` を記録。

- **cron式**: チェック条件は `前回実行時刻 < 今回の予定実行時刻 ≤ 現在時刻`。これにより `0 9 * * *` が 9:00〜9:59 の間に何度もマッチする問題を防ぐ。
- **インターバル**: チェック条件は `lastRun + interval ≤ 現在時刻`。

### 実行タイミングと長時間実行

- tickはジョブの走査とadmissionだけを待ち、ハンドラーPromiseの完了を待たずに返る。
- 同じジョブの実行中は、プロセス内のin-flight管理により次のtickで重複admissionしない。ハンドラーが完了した時点でin-flightから解除する。
- `lastRun` はハンドラーの完了時刻ではなくadmission時刻を保存する。成功または `NonRetryableError` では保存し、一時的なエラーでは更新しない。完了順が逆になっても、状態ファイルはジョブID単位の更新を直列化して他ジョブの更新を保持する。
- cron式は現在の秒切り捨て済み分が式に一致した場合だけ実行し、遅延中に過ぎたslotを再生しない。同じslot内では完了後も再実行しない。
- インターバルはadmission時刻を基準にし、実行中に複数回のintervalが経過しても積算catch-upしない。完了後の次のtickでは最大1回だけ実行する。
- in-flight管理はプロセス内だけで、再起動前の実行を引き継がない。再起動時は `state.json` に保存された `lastRun` だけで重複を抑止する。

`state.json` の構造例:

```json
{
  "daily-report": { "lastRun": "2025-01-01T09:00:00.000Z" },
  "mail-check": { "lastRun": "2025-01-01T09:30:00.000Z" }
}
```

---

## Memory export（`jobs/memory-export.ts`）

backendごとに1 jobを定義し、`settings`にbackend接続・eligible groups・batch sizeを置きます。handlerは既存runtime queueへのenqueueのみを行います。queue workerがstartup時の `_jobs` cacheからcron IDを解決し、read-only canonical session trajectoryからbounded batchをexportします。restart前のjobも新cacheが正です。同一backendの直列化・retry・lease・recoveryは既存queueへ委譲します。詳細とexampleは [Agent Memory export](../agent-memory.md) を参照してください。

画面画像の要約はcronではなく、capture保存後とHost起動時にpending枚数を確認するScreen Capture機能が起動します。設定とMac/Tailscale導入手順は [画面画像の収集と要約](../screen-capture.md) を参照してください。

## メール処理（`jobs/mail.ts`）

メールハンドラーは未読メールを取得し、Mail機能モジュールで本文・ACK対象のメールID・送信元・`List-Id`・件名から決定論的なmailRouteKeyとfeature入力を作ってinboxへ投入する（本文はroutingに使わない）。GitHubのPR件名 `(PR #number)` に対応し、PRのCI失敗通知は件名のコミットハッシュから関連PRを照会する。一意に特定できない場合は送信元routeを使い、APIエラー時は未読のまま再試行する。LLM sessionはメールごとに独立する。Mail機能がrouteのthread名とmapping（group・親channel・route単位）を所有し、共通Discord deliveryはthreadの解決・作成・送信だけを行う。Mailの `channelId` は既存threadではなく親Text Channelが必要。全delivery chunkが`sent`になった後にだけメールを既読化する。

1. 未読メールを取得して本文を取得する。
2. `enqueueCronInbox()` にメールIDとcron job ID + Graph message ID由来の冪等キー `mail:graph:<encoded-cron-job-id>:<encoded-message-id>` を付けてjobを投入する。各IDは区切り文字との衝突を避けるためURI encodeする。Mailは `direct` + `fresh` として処理される。同一cron job + 同一Graph messageはqueue jobがactive（`queued` / `retry_wait` / `claimed` / `running`）の間だけdedupeし、別cron jobは独立してenqueueできる。
3. cron enqueue/pollerが設定された方式に従ってproviderのconcurrency設定とセッション順序を保ったままAIを実行し、delivery workerが投稿先を確定する。`item-thread` は一時sessionでAIを実行し、通常応答がある場合だけ親メッセージ→session昇格→thread作成の順でmaterializeする。
4. AIが成功し、生成された全delivery chunkが`sent`になった後にだけ対象メールを既読化する。

queue jobがterminal（`completed` / `dead_letter`）ならdedupeせず、Graphが未読で返すメールを次回cronで新しいjobとして再enqueueする。既存のenqueue transaction内でmailのterminal keyを解放・再登録するため、並行handlerも同じactive jobへ収束する。Mail以外のqueue idempotencyは変更しない。

Graphの未読状態をsource側のretry signalとし、Agentのdead-letter、terminal delivery failure、配送後や明示的な配送抑止後のGraph ACK失敗でも通常のcron経路から再処理する。ACK専用state・worker・startup/runtime reconciliationは持たず、既存のqueue retry・delivery・配送後ACKを維持する。`completed` はAgent結果の保存完了であり、Discord配送完了とは別なので、配送待ちでもGraphが未読なら再enqueue可能。これはactive-only contractの境界であり、terminal後の再処理ではDiscord投稿が重複しうる。

## 運用メモ

`historyMode` の設定・queue payloadを自動変換する互換経路はない。導入時は新surfaceへ設定を直接書き換え、旧runtimeで受付済みcron jobを完了させてから切り替える。session DBのidentityや保存済み種別は変更しない。

### config/cron.json の変更を反映するには再起動が必要

起動時に `loadAndValidateCron()` がジョブ定義を一度だけ読み込み、結果を `runner.ts` のモジュールレベル変数 `_jobs` にセットする。`tick()` は毎分このメモリ上の `_jobs` を参照するだけでファイルの再読み込みは行わないため、`config/cron.json` を編集してもプロセスを再起動するまで変更は反映されない。これは `group-config.ts` と同じキャッシュ戦略。

`config/cron.json` は省略可能なため、ファイル自体が存在しない場合は `loadAndValidateCron()` がエラーにせず空配列を返し、cron が空扱いで起動する。この場合も後からファイルを配置しても再起動するまで cron は動き始めない（次の tick で自動回復する仕組みは存在しない）。

---

## スコープ外（別途検討）

- **一般deliveryのリトライ上限**: deliveryの再試行上限は未定義で、連続失敗時に `state.json` の `retryCount` で追跡してリトライを打ち切る設計（issue #74）。

- **`allowedTools` / `allowedSkills`**: ジョブごとにグループ設定のツール・スキルをオーバーライドする機能（issue #73）。`InboxMessage` と `sendMessage` 両方への対応が必要なため別途実装。

- **Discord カスタムスラッシュコマンド**: cron のトグル、ローカル LLM の Heartbeat 制御など（issue #70）。

## 没・保留

- **`session: "fixed"`**: 実行間で会話履歴を持ち越す固定セッション方式。channelId を永続化するだけでは複数ジョブがセッションを共有してしまう問題があり、エージェントの最終的なレスポンスのみを共有するか、具体的なユースケースも固まらなかったため削除。

- **サーバーが落ちてた間のジョブ再実行**: 停止中に実行予定だったジョブを再起動時に自動実行する機能。`state.json` の `lastRun` に加えて「次の予定実行時刻」も記録する必要があり実装が複雑になるため保留。

- **Heartbeat**: 一定間隔でエージェントに話しかけ続けるユースケース。実行のたびにセッションが積み上がりコンテキストが肥大化するため cron 基盤では対応しない。必要であればカスタムジョブとしてエージェントに作成依頼することを推奨。
