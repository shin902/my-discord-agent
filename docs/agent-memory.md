# Agent Memory

## Owner別Markdownと新規sessionの初回選択

Main、channel Bot、Bot Task、Bot cronは共通の実行経路で、既存の `groupName + agent_id` をownerとして使います。正本は既存group workspaceの `agent-memory/<encoded-owner>/` 内の直下の `.md` ファイルです。Agentには `/workspace/agent-memory/<encoded-owner>/` として見えます。`<encoded-owner>` は `owner-` + Agent IDのUTF-16LEバイト列のbase64url（paddingなし）。MainのIDは `main` です。任意のBot名を単一の安全なパス要素に変換し、Bot名の変更や新しいmountは不要です。

共通system promptは、役立つ安定した事実・好み・教訓を得たとき、古い・誤った記憶に気づいたときにAgent自身が作成・更新・整理するよう指示します。1テーマ1Markdown、内容が分かるファイル名とし、**Agent自身が文字数を数えて本文を500文字以内**にします。詳細への参照を置く場合も判断に必要な要点は本文に残します。機械的な切断・文字数validatorはありません。read/write/edit等の既存権限を使い、ツール権限を暗黙に追加しません。

Hostは新規sessionの最初の依頼本文（cronは実行プロンプト）と当該ownerの候補ファイル名をJevに送ります。本文はJevには送らず、公式 [`@typesafe-ai/sdk`](https://docs.typesafe.ai/sdk/javascript) の `systemOne({state, questions})` で候補ごとのNoul質問を1つのrequestにまとめます。質問IDだけでなくinstructionsにファイル名を含め、「似た話題か」ではなく「今回の回答や作業判断に具体的に役立つか」を判定します。返されたID・型・有限な0〜1の値を検証し、閾値以上から降順で最大5件を選びます。同点はファイル名の安定した順序です。無関係な記憶で件数を埋めません。サブディレクトリやsymlinkは自動選択対象にしません。

`config/config.json` の `agentMemory.threshold` は0〜1（初期値 **0.7**）。未設定・不正値は0.7を使い、不正値には警告します。0.5付近の曖昧な関連より具体的な有用性を優先するための**仮値**であり、校正済みの正解確率・検証済みの精度ではありません。たとえば「京都旅行の夕食を決めたい」に対する「京都の食の好み.md」と「関連するだけ.md」をモックの0.90/0.89で比較し、閾値0.90なら前者だけを採用する境界動作をテストしています。これはJevが実際にそのスコアを返すという証拠ではありません。日本語ファイル名での実データ精度と閾値調整、実APIの利用はMVPでは未検証です。

認証はHostの環境変数 **`TYPESAFE_API_KEY` のみ**を使います。通常の `pnpm start` はGit管理外の `.env` を読み込みます（開発起動等ではHost processの環境へ設定）。group設定やソース、Agent workspaceにキーを書かず、Runnerへの環境変数・payloadにも渡しません。候補なしならAPIも認証も不要です。候補があるのにキーがない場合は失敗コンテキストを保存し、会話を続行します。設定変更はHost再起動後に反映します。SDKの既定モデル `jev-latest` を使用し、SDKのHost環境設定はSDK仕様に従いますが、ログは明示的に `off` に固定して依頼・ファイル名・APIエラー本文を出力しません。

インストールしたSDK **0.6.0** の型と実装に合わせ、`retry.maxRetries: 4`（初回込み最大5試行）、1試行10秒を使います。SDKのみが接続・timeout・408/429/5xxを再試行し、外側にretryを重ねません。SDK既定の500ms開始・指数backoff（上限5秒、最大25% jitter）、最大60秒のRetry-Afterを使います。選択全体のAPI待機上限には既存 `agent.timeoutMs` を使い、Runnerのtimeoutとは別に計測します。既存の実行AbortSignalはAPIと待機にも伝播します。認証・入力検証エラー、該当なし、キャンセルは再試行しません。

Node 22ではSDKのレスポンスcloneと通信中断の組み合わせでプロセスが終了する[既知問題](https://github.com/typesafe-ai/typesafe-sdk-js/issues/2)があるため、専用fetchが本文を読み切ってからSDKへ渡します。本文受信中も同じtimeout・AbortSignalが有効で、SDKがcloneする対象は通信から切り離されたメモリ上のレスポンスになります。

session DBの既存custom entry `initial-agent-memory` に、`selected` / `no-candidates` / `no-match` / `failed` と実際に注入する本文を保存します。空結果は空文字のまま保存し、LLMへ空メッセージを送りません。最終失敗は「メモリ選択に失敗しました。今回は追加メモリなしで続行します。」を追加コンテキストにします。Markdownの後日の編集・削除は保存済みsnapshotに影響しません。実ユーザー発言・source provenanceとは別entryで、初回のユーザー発言より前に保存され、同じ順序でresume時も展開されます。既存contextFilesのbootstrapは従来どおり先頭へ並べられます。

role snapshotしかないBot Taskでも初回選択を行います。結果はRunner起動**前**に保存するため、通常の実行retry・継続・rename/resumeでは再選定・重複注入しません。初回markerのない既存会話（user/assistant/toolResultあり）へは遡って注入しません。キャンセルは完了結果を保存せず中断し、保存前のプロセスクラッシュ・キャンセル後の再実行は選定し直せます。session DBへの保存失敗は実行を止めます。同一sessionの直列化は既存queue/admissionが担います。

これは共有group workspace内のowner別自動選択であり、同じgroupのAgentが他ownerのファイルを手動で読むことを禁止するアクセス隔離ではありません。従来のgroup境界、memory_core/exportは変更しません。継続sessionでの再選定・追加注入（#580）、embedding、抽出cron、専用編集ツール、Subagent専用永続Memoryは対象外です。HostとRunnerを同じcheckoutからbuildし、Runner imageを更新してから再起動してください。DB schema変更・移行は不要です。

## NanoClaw-compatible workspace memory

NanoClaw-style file memory is an opt-in third memory option implemented by the
`agent-memory-setup` Skill. For this NanoClaw option, the host never creates memory files at startup or during
an Agent run. It does not replace or modify legacy `MEMORY.md` /
`memory/SELF.md`, their cron jobs, MemoryCore, session trajectory, or exact
RSS/queue state. Operators may use any of these options independently or
together; no data is migrated or synchronized automatically.

Add `agent-memory-setup` to the profile's `skills`, enable `bash` and the ordinary
filesystem tools, restart the host, then explicitly ask the Agent to initialize
NanoClaw/OKF memory. The Skill runs its sandbox-local initializer, which creates
only missing files and never overwrites existing workspace files:

```text
memory/
├── index.md
└── system/
    ├── index.md
    └── definition.md
```

The bundled templates are adapted from NanoClaw commit
[`0399a6dfa98fa8fb27b7b267749ed04d6880379b`](https://github.com/nanocoai/nanoclaw/tree/0399a6dfa98fa8fb27b7b267749ed04d6880379b).
Its MIT notice is retained in `templates/SKILLS/agent-memory-setup/LICENSE`.

`contextFiles` is not an initializer. After initialization, it can optionally
inject the two entry points into a new session's first context:

```json
{
  "skills": ["agent-memory-setup"],
  "tools": ["bash", "read", "write", "edit", "list", "glob", "grep"],
  "contextFiles": [
    { "path": "memory/index.md", "maxChars": 16000 },
    { "path": "memory/system/definition.md", "maxChars": 16000 }
  ]
}
```

Merge these entries with capabilities already required by that profile and
restart after changing configuration. Paths are relative to the group
workspace. Only explicitly listed files are loaded; missing files are skipped
and subordinate memory files are not expanded.

`contextFiles` is not added retroactively to an existing session. In particular,
a `shared` channel that was used to run the initializer keeps its existing
session after restart. Continue there by explicitly reading the workspace
memory files with filesystem tools, or start a new thread/channel with a new
session ID after configuring `contextFiles` to receive the bootstrap. The Agent
manages initialized memory with the ordinary filesystem tools. Existing legacy
files and sessions are not migrated or deleted.

## MemoryCore Agent Memory export

Agent Memory exportはcanonical session trajectoryから作る派生projectionです。cronは実行機会とbackend設定を持ち、処理は既存runtime queueへ委譲します。recall、prompt injection、embeddingは実装しません。

```text
config/cron.json (schedule + backend settings)
  → cron handler (enqueueのみ)
  → runtime.sqlite (queue / ordering / lease / fencing / retry / dead-letter / recovery)
  → Memory export worker
      → runtime.sqlite (committed_conversationsの採用entry参照を取得)
      → data/sessions/<group>/sessions.sqlite (本文をread-only取得)
      → Memory Backend Adapter → TencentDB / other backend
      → data/memory-export.sqlite (export成功markerのみ)
```

## 設定

backendごとに `config/cron.json` へhandler付きjobを1つ定義します。[example](../config/cron.example.json) は誤送信防止のためdisabledです。対象groupを確認して明示的に有効化してください。通常のgroup/channel AgentConfigやDiscord配送設定は不要です。

```json
{
  "id": "memory-tencent-main",
  "schedule": "1m",
  "enabled": true,
  "handler": "jobs/memory-export.ts",
  "settings": {
    "type": "tencentdb",
    "eligibleGroups": ["main"],
    "batchSize": 50,
    "baseUrl": "http://127.0.0.1:8420",
    "serviceId": "default",
    "teamId": "default",
    "agentId": "my-discord-agent",
    "bearerTokenEnv": "MEMORY_CORE_GATEWAY_API_KEY",
    "timeoutMs": 10000
  }
}
```

| settings | 契約 |
|---|---|
| `type` | 現在は `tencentdb` |
| `eligibleGroups` | exportを許可するgroup名の明示リスト（1件以上）。private会話の送信先を運用者が確認する |
| `batchSize` | 1 jobで成功させるturn数の上限。1〜1000、既定50 |
| `baseUrl` | 既定 `http://127.0.0.1:8420`。非loopbackはHTTPS必須。HTTPはliteral `127.0.0.1` / `[::1]` のみ。埋め込みcredentials、query、fragmentは禁止。redirectは追従しない |
| `serviceId` | `x-tdai-service-id`。既定 `default` |
| `teamId` / `agentId` | TencentDB scope。既定 `default` / `my-discord-agent` |
| `bearerTokenEnv` | Bearer tokenを読む環境変数名。値をJSONへ書かない。MemoryCore v3 data-planeでは実質必須 |
| `timeoutMs` | 1 HTTP requestのtimeout（body読み込みを含む）。1〜120000ms、既定10000 |

MemoryCore sidecarの起動・鍵設定は [config.md](config.md#memorycore-sidecarの起動) を参照してください。

### L1/L2/L3 custom prompt

MemoryCore起動後、リポジトリ管理の品質promptを現在のagent scopeへprovisionします。

```bash
pnpm memory-core:prompts
```

このcommandは`config/cron.json`にある各`jobs/memory-export.ts` / `type: "tencentdb"` jobを接続設定の正本として読みます。`baseUrl`、`serviceId`、`teamId`、`agentId`、`bearerTokenEnv`、`timeoutMs`はexportと同じ値が使われます。該当jobがない場合は失敗します。secret本体だけはJSONへ置かず、`bearerTokenEnv`で指定した環境変数（exampleでは`.env`の`MEMORY_CORE_GATEWAY_API_KEY`）から読みます。

このcommandは各jobのagent scopeについて、各layerの同名promptを作成または更新し、applyした後、MemoryCoreのeffective promptを再取得して内容とsourceを確認します。L1/L2/L3 schemaやpipeline、scope自体は変更しません。

cron job IDは安定したbackend / export namespaceです。同じlogical backendならIDを維持します。別のbackend、team/agent scope等へ既存履歴を再exportしたい場合は**新しいcron job ID**を使います。

実行時のauthorityはstartupでロードされたcron設定cacheです。変更はrestartで反映し、process中のfresh read・hot reloadはしません。restart前にenqueueされたjobも新processのcacheで処理します。対応IDが削除、disabled、または別handlerへ変更されていれば、remote exportせず正常完了（no-op）します。handlerの同一性はcron loaderが解決した関数で判定するため、`./jobs/memory-export.ts`等の同値pathやloaderが受理する拡張子aliasでもexportできます。旧settings snapshot、generation、fingerprintの復元・比較はありません。settings不正・未設定credentialはworkerでnon-retryable failureになります。

## canonical sourceとturn

通常human Discord message（Default `0` / Reply `19`）のuser entryには、Memoryの設定と無関係に汎用provenanceを保存します。

```json
{"kind":"discord","sourceId":"<Discord message ID>","actorId":"<Discord user ID>","messageType":0,"createdAt":"2026-09-01T01:00:00.000Z"}
```

`session_entries.source_json` はnullableです。会話本文・session identityは既存columnを使い、candidate flagやbackend設定は追加しません。source metadataはLLM contextへ混ぜません。auto-thread起点でも、返信先message IDとは別に元のDiscord message IDを保持します。`createdAt`は元Discord messageの作成時刻です。exportのuser timestampにはこれを使い、startup backfill等の処理時刻と混同しません。canonical user entryのtimestampは処理時刻のまま維持し、`createdAt`のない旧provenanceだけはそのentry timestampへfallbackします。assistantはcanonical entryの生成時刻を使います。

Runnerはcanonical entryをappendし、そのrunの入力userと最終assistantのstable entry IDをhostへ返します。hostはrunnerの正常終了後、既存のfencing検証を伴う `QueueRepository.commitResult()` の同一transactionで、job成功・delivery・`committed_conversations`参照を確定します。参照はgroupとentry IDだけで本文を特定し、session IDを複製しません。sandboxへruntime DBを公開せず、job ID / fencing tokenをentryへ伝播する必要もありません。

- RunnerはMemory eligibilityにかかわらず入力userと実際の最終assistantのIDを返します。同じrun内にfollow-up promptがあってもこのpairを確定し、途中のassistantへfallbackしません。`committed_conversations`はqueueが成功commitした会話の参照であり、Memory対象一覧ではありません。たとえば非空の`length`応答がqueueで成功commitされれば、そのpairも保存されます。
- exporterはcommit済み参照で指定された2 entryを読み、`stopReason: stop`、errorなし、非空textをMemory eligibilityとして判定します。`length`、error / aborted、tool call途中、空response、provenanceのないuser、削除されて参照不能なentryは送信しません。不適格なfinalから途中の`stop`へfallbackせず、raw trajectoryの走査やsource jobのattempt照合も行いません。
- 未commitや失敗結果は採用参照を作りません。crash前やstale runnerの遅延entryも参照に選ばれず、成功したretryの結果だけが確定します。queueの既存成功・失敗判定は変更しません。
- `./command nonexistent`等のAgent起動前のlocal responseも、user＋assistantをcanonicalへ保存し、通常と同じ参照commit経路を通ります。
- Bot Task、Subagent、cron、RSS、mail、Discord Bot自身の発言、slash commandには初版のDiscord会話provenanceを付けません。
- 送信元はsession DBのみです。通常runtime jobのpayload/result、Discord deliveryから本文を再構築しません。本文はcanonicalに保存されたtextです（添付ファイル案内等を含む場合があります）。thinkingやtool payloadは送信しません。
- `<NO_REPLY>` はDiscord配送の抑制であり、非空の正常assistantとして保存されていればexport対象になり得ます。

旧rollout時、session schema v1〜v3は通常のsession書き込み経路でv4へ更新されていました。現行v5では旧schemaの自動移行はせず、[停止・バックアップ・手動変換](storage.md#session-trajectory)が必要です。v3の `execution_json` とその検索indexはMemory以外に利用がないため削除します。entry ID・本文・sourceは保持し、migrationはwrite lock取得後にversionを再確認します。export側はDB作成・migrationをしません。既存履歴の採用結果を本文・旧attempt情報・runtime jobから推測してbackfillしません。

## queueと成功ledger

cron handlerは1回につきbounded batchのhost-only jobを1件enqueueするだけです。producer入力は `jobKind: memory-export`、cron job ID、timestampのみで、queue保存時に既存の `sessionId: memory-export:<cronJobId>` と内部互換用の空文字group/channel/contentを補います。Agent実行・Discord配送には使いません。会話本文、turn固定リスト、接続設定、scope、secret selector、eligible判定、設定snapshotを永続化しません。

同一backendのjobは既存session orderingで直列化し、retry待ちの先行jobも追い越しません。backend間は独立です。通常pollerのheartbeat・lease・fencing・retry・dead-letter・restart recoveryをそのまま利用し、Agent container、LLM provider lock、Discord deliveryは使いません。内部jobはqueue metricsには含め、Agent metricsからはjob discriminatorで除外します。

ledgerは次の成功事実だけです。

```sql
CREATE TABLE exports (
  backend_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, group_name, source_kind, source_id)
);
```

backendが1turnを受理した直後にmarkerを書きます。batch途中で失敗してもそれまでのmarkerは残り、queue retryでは成功済みturnを送信しません。ledgerにpending、attempt、lease、retry、error、payload、configはありません。

network、timeout、408、429、5xxは既存queueのretryへ、明確な設定不備や恒久API errorはnon-retryableとしてdead-letterへ進みます。失敗したturn以後はそのbatchで送信しません。後続の定期cron jobは新しい実行機会なので、dead-letterが未export sourceを永久に除外することはありません。backend停止時はcronをdisabledにしてrestartすると、待機jobもno-opで収束できます。

## 制約と運用

- **at-least-once**: remote受理後・marker保存前のcrashでは重複が起こり得ます。2-phase commit、outbox、remote idempotency emulationはありません。
- ledgerだけを削除すると、採用参照とsession本文が残るturnがremoteへ再送されます。再構築は新しいbackend namespaceとcron IDを組み合わせるか、backend namespaceと対応markerを一緒にresetしてください。
- `committed_conversations`は通常job retentionの対象外で、現時点では自動削除期限を設けません。jobs削除後も参照とsession本文が残る限り再exportできます。session renameでは同じgroup内のentry IDが維持されるため参照更新は不要です。参照不能になったentryを近隣の本文で補完しません。
- backup / restoreにはruntime DB（採用参照を含む）とsession DBの両方が必要です。session DBだけを削除・再作成するとentry IDが再利用されるため、古い参照を残したまま同名groupのDBを置き換えないでください。source廃棄時は対応する参照・ledger・remote dataの扱いも明示的に決めます。
- 確認するのはsource jobの結果commitであり、Discordの`sent`ではありません。配送retryはAgentを再実行せず、Memory exportの判定とも独立です。
- groupは設定順、group内は採用参照commit順に走査します。batch数はremote成功turn数を制限しますが、履歴の走査量を制限するcursor stateは持ちません。大きな履歴や先頭groupの継続的な大量流入では走査コスト・後続groupの遅延が増えます。
- 通常queue/cronと同じ単一host process・Discord readinessの起動条件を引き継ぎます。Memory専用schedulerやmulti-host lockはありません。
- queue状態は [runtime-dbスキル](../.pi/skills/runtime-db/SKILL.md) のread-only手順で確認します。`cronJobId` / `jobKind` と通常のjob statusを使い、成功件数はledgerをread-onlyで確認します。runtime backupにsession DB・export ledgerは含まれません（[storage.md](storage.md)）。

### attempt照合方式からのrollout（旧v4導入時の記録）

以下は過去のv4導入手順であり、現行v5への導入手順ではありません。現行runtimeはv1〜v4のsession DBを自動移行しません。停止・バックアップ後に[storageのv4→v5変換手順](storage.md#session-trajectory)を完了してから起動してください。

旧導入時は、更新前にexport可能な旧会話を既存exporterで処理し、runtimeを停止してruntime DB・session DB・ledgerをbackupします。**hostとAgent Runner imageを同じversionへ更新してから再起動**してください。旧runnerとの混在はサポートしません（旧runnerは採用参照を返さず、v4 sessionも読めません）。runtime schema v7は空の採用参照tableを追加し、各groupのsessionは通常アクセス時にv4へ更新されます。旧履歴の再exportは新方式へ自動移行しませんが、既存ledger / remote memoryは保持されます。downgrade時はhost / imageだけでなく更新前DBも復元が必要です。

### 旧capture経路からのrollout

旧shadow job互換実行・payload migrationはありません。**更新前に旧runtimeで未完了shadow jobをdrainし、queueに残っていないことをread-onlyで確認してから停止**してください。drainできない場合はrolloutを止め、既存queueの運用手順で対処します。ad-hocなSQL更新でleaseやdelivery状態を改変しないでください。

旧top-level `config/config.json.agentMemory` を削除し、必要なbackendを `config/cron.json` に移してrestartします。旧設定は新runtimeでは参照されません。新provenanceと採用参照が保存される以降の成功commit済み会話が対象となり、既存remote memoryはそのまま保持できます。新経路のqueue、session、ledgerを確認してから通常運用へ戻してください。
