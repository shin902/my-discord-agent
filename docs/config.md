# 設定ファイルリファレンス

## 概要

設定は役割ごとに `config/` 配下の複数ファイルに分かれている。各ファイルは対応する `*.example.json` をコピーして作成し、環境に合わせて編集する。

```
config/
  config.json              # Bot profile・defaultModel・proxy・agent などの設定
  config.example.json
  providers.json           # AI プロバイダーごとの実行ポリシー（省略可）
  providers.example.json
  credentials.json         # AI プロバイダー・外部サービスの接続設定
  credentials.example.json
  groups.json              # チャンネル→グループのマッピング＋エージェント設定
  groups.example.json
  cron.json                # 定期実行ジョブ定義（省略可）
  cron.example.json

groups/{name}/
  AGENTS.md                # グループのシステムプロンプト
```

AgentConfig（`model` / `tools` / `skills` / `mounts`）は、コンテナにマウントされない静的設定として管理する。通常のDiscord会話では `group → channel`、cronでは配送先のchannel/thread設定を継承せず `group → cron job` の順で解決する。`groups/{name}/` はコンテナに書き込み可能な領域としてマウントされるため、エージェント自身が設定を書き換えられないようにする。`allowMention` と `toolLogArgs` はgroup限定の配送・観測設定であり、channel/cronからはoverrideできない。

| ファイル | 必須 | トップレベル形式 | 内容 |
|---|---|---|---|
| `config/providers.json` | — | 配列（省略時は全 provider が `serial`） | AI プロバイダーごとの同時実行ポリシー |
| `config/credentials.json` | ✓ | 配列 | AI プロバイダー・外部サービスの接続設定 |
| `config/groups.json` | ✓ | 配列 | チャンネル → グループのマッピング |
| `config/cron.json` | — | 配列（省略時は空扱い） | 定期実行ジョブ定義 |
| `config/config.json` | ✓ | オブジェクト | Bot profile・`defaultModel`（必須）・proxy・agent・Agent Memory 設定 |

> **`opencode-go` の `kimi-k2.6` は非推奨**: 大規模なツールコールで API エラーが頻発する問題が `pi-agent-core` の更新でも解消せず、他モデル（deepseek-v4 等）でも同様の報告がある（#107）。`zai` の `glm-4.7-flash` は無料枠（並列実行1まで・コンテキスト制限なし）で安定して動く。プロバイダー同時実行のデフォルトは `serial` のため、`zai` は追加設定なしでも安全に利用できる。

## config/config.json の `agentMemory`

TencentDB Agent Memory の shadow mode（回答へのmemory注入なし）を明示的に有効化する設定です。既定では無効です。`eligibleGroups` に列挙したグループは、運用者がprivateな通常Discord会話として明示的に適格と宣言した場合だけ対象になります。cron、public scope、Bot、Subagent、mail/RSSのジョブは対象外です。

```json
{
  "agentMemory": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:8420",
    "serviceId": "default",
    "teamId": "my-discord-agent",
    "agentId": "main",
    "eligibleGroups": ["private-chat"],
    "timeoutMs": 10000
  }
}
```

通常のprivate chatが正常完了すると、durable queueに保存された入力payloadと完了済みagent resultからuser/assistantの1往復を組み立て、runtime.sqliteの独立したshadow jobへ登録します。session JSONLは引き続き会話のcanonical raw historyとして保持しますが、shadow submissionの入力として読み直す経路ではありません。shadow jobは `POST /v3/conversation/add`（L0）へ `team_id`、`agent_id`、`user_id`、`session_id` を付けて非同期送信します。送信結果は `[agent-memory]` の構造化ログと通常queueのjob statusで確認できます。TencentDBが停止・タイムアウトしても通常のDiscord応答は成功したままで、shadow jobだけがqueueのretry/dead-letter対象になります。

ローカルのMemoryCoreは認証なしで接続できます。認証を有効にした環境では、`bearerTokenEnv` にBearer tokenを保持する環境変数名を指定してください。未指定時は`Authorization`ヘッダーを送信しません。非loopbackの接続先はHTTPSを必須とし、認証なしHTTPは文字列どおりの`127.0.0.1`または`[::1]`に限定します（`localhost`はDNS解決を検証しないため許可しません）。token自体やその他のsecretを設定ファイルへ書かないでください。現在はshadow writeのみで、recall、embedding、Ruri prefix、context injectionは行いません。TencentDB v3の`conversation/add`契約にはクライアント指定のmessage/request IDやidempotency keyはなく、accepted IDはサーバー生成です（[v3 API仕様](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/main/MemoryCore/v3-api-memorycore-doc.md)）。そのためshadow送信はローカルqueueのidempotencyによるat-least-once配送で、応答受領後のprocess crashではMemoryCore側に重複L0が発生し得ます。これはupstream契約上の制約であり、未対応のrequest fieldを独自追加して重複排除を主張しません。

| キー | 必須 | 内容 |
|---|---|---|
| `enabled` | — | `true` のときだけshadow modeを動かす。既定は`false` |
| `baseUrl` | — | TencentDB MemoryCoreのURL。HTTPはloopbackのみ、非loopbackはHTTPSのみ。query/fragmentと埋め込みcredentialは禁止。`/v3/conversation/add`を安全に追加して呼び出す |
| `serviceId` | — | `x-tdai-service-id`へ送るMemoryCoreのinstance ID |
| `bearerTokenEnv` | — | 任意。Bearer tokenを読む環境変数名。未指定なら認証なし |
| `teamId` / `agentId` | — | 全対象会話へ付与する固定isolation identity |
| `eligibleGroups` | — | shadow writeを許可するprivate group名の明示リスト。既定は空 |
| `timeoutMs` | — | MemoryCore HTTP timeout（1〜120000ms、既定10000） |

### MemoryCore sidecarの起動

`compose.memory-core.yaml`はMemoryCore単体を公式image `agentmemory/memory-core:1.0.1`から起動します。Memory Hub / Memory ProxyやTencentDB repositoryのclone、自前buildは不要です。ホストへの公開はloopbackのみに限定され、MemoryCoreのデータはDocker volume `memory-core-data`へ永続化されます。

exampleをGit管理外の実設定へコピーし、MemoryCore内部の抽出・統合に使うOpenAI-compatible LLMを`config/memory-core.yaml`の`llm`へ設定します。このファイルにはAPI keyが含まれるためcommitしないでください。

```bash
cp config/memory-core.example.yaml config/memory-core.yaml
```

```yaml
llm:
  baseUrl: "https://api.openai.com/v1"
  apiKey: "replace-me"
  model: "gpt-4o-mini"
```

起動してhealth endpointを確認します。

```bash
pnpm memory-core up -d
curl "http://127.0.0.1:${MEMORY_CORE_PORT:-8420}/health"

# 運用コマンド
pnpm memory-core ps
pnpm memory-core logs -f memory-core
pnpm memory-core down
```

Gateway認証はローカルloopback運用では未設定にできます。`MEMORY_CORE_GATEWAY_API_KEY`を設定して認証を有効にする場合は、`agentMemory.bearerTokenEnv`へ同じ環境変数名を指定してください。API keyの値自体はJSONへ書きません。`MEMORY_CORE_PORT`を変更した場合は、`agentMemory.baseUrl`のポートも同じ値に合わせてください。

```json
{
  "agentMemory": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:8420",
    "bearerTokenEnv": "MEMORY_CORE_GATEWAY_API_KEY",
    "eligibleGroups": ["private-chat"]
  }
}
```

Composeは`config/memory-core.yaml`を読み取り専用でマウントします。設定項目の雛形は [`config/memory-core.example.yaml`](../config/memory-core.example.yaml) にあります。image tagはデータ形式のmigration notesを確認してから明示的に更新し、`latest`へは変更しないでください。volumeを削除する`down -v`は保存済みmemoryを消すため、通常の停止には使わないでください。

## config/providers.json

AI プロバイダーごとの同時実行ポリシー。ファイルを省略した場合や provider のエントリがない場合は、安全側の `serial` を使う。複数実行できる provider だけ `parallel` を明示する。

```json
[
  { "provider": "zai", "concurrency": "serial" },
  { "provider": "codex-oauth", "concurrency": "parallel" },
  { "provider": "llama-cpp", "concurrency": "serial" }
]
```

- `serial`: 同じ provider の実行を FIFO で1件ずつ処理する
- `parallel`: 同じ provider でも並列実行を許可する

`serial` のロックは provider ごとに独立する。たとえば `local-a` と `local-b` がどちらも `serial` でも、両者は同時に実行できる。同じセッションのメッセージはこの設定とは別のセッションチェーンで常に受信順に処理される。

## config/credentials.json

AI プロバイダーや外部サービス（Microsoft Graph・Browserless 等）の接続設定。トップレベルは配列。
詳細は `docs/config/credential-proxy.md` を参照。

```json
[
  {
    "provider": "zai",
    "envVars": ["ZAI_API_KEY"],
    "baseUrl": "https://api.z.ai/api/coding/paas/v4"
  },
  {
    "provider": "anthropic",
    "envVars": ["ANTHROPIC_API_KEY"],
    "baseUrl": "https://api.anthropic.com"
  },
  {
    "provider": "codex-oauth",
    "forceCustom": true,
    "envVars": ["CLIPROXY_API_KEY"],
    "baseUrl": "http://localhost:8317/v1",
    "api": "openai-responses",
    "contextWindow": 192000,
    "maxTokens": 8192
  },
  {
    "provider": "llama-cpp-qwen3",
    "baseUrl": "http://localhost:8080/v1",
    "api": "openai-completions",
    "compat": { "thinkingFormat": "qwen-chat-template" }
  }
]
```

API キーなどの機密情報は `.env` に記載し、`envVars` で参照する。Codex OAuth / CLIProxyAPI の詳しい構成は `docs/guides/codex-oauth-cliproxyapi.md` を参照。

## config/groups.json

チャンネル ID とグループ名・セッションモードのマッピングに加えて、グループごとのエージェント設定（モデル・ツール・allowMention 等）。トップレベルは配列。

```json
[
  {
    "name": "chat",
    "model": { "provider": "zai", "modelId": "glm-4.7-flash" },
    "tools": ["tavily-search", "bot"],
    "allowMention": false,
    "toolLogArgs": true,
    "channels": [
      { "channelId": "111", "sessionMode": "shared" },
      {
        "channelId": "222",
        "sessionMode": "shared",
        "requiredMention": true,
        "tools": ["read"],
        "skills": [],
        "mounts": []
      }
    ]
  },
  {
    "name": "thread",
    "model": { "provider": "zai", "modelId": "glm-4.7-flash" },
    "tools": ["tavily-search", "agent-reach", "bash", "read", "write", "edit"],
    "skills": ["session-logs"],
    "allowMention": true,
    "toolLogArgs": true,
    "channels": [
      { "channelId": "222", "sessionMode": "thread" },
      { "channelId": "333", "sessionMode": "auto-thread" }
    ]
  }
]
```

| キー | 必須 | 内容 |
|---|---|---|
| `name` | ✓ | `groups/{name}/` ディレクトリ名と対応 |
| `channels` | ✓ | チャンネル ID とセッションモードのマッピング |
| `requiredMention` | — | チャンネル単位で指定できる任意の boolean。`true` の場合はBotへのメンションを含む通常メッセージだけを処理し、省略時（既定）は制限しない。親チャンネルのポリシーは子スレッドにも適用され、スラッシュコマンドは対象外 |
| `model` | — | AgentConfig。`provider`/`modelId`/`thinkingLevel`。channelで指定するとgroupのmodelオブジェクトを完全置換 |
| `tools` | — | AgentConfig。エージェントに渡す MCP ツール名の配列。`bot` と `subagent` は正確な名前を明示した場合だけ有効なcontext-created tool。channelで指定するとgroupの配列を完全置換するため、groupで許可したtoolもchannel側で指定しなければ無効 |
| `allowMention` | — | 元メッセージへの reply 形式で送信し、返信先ユーザーに通知するか。省略時は返信するが通知しない |
| `toolLogArgs` | — | ツール実行ログに引数を含めるか |
| `skills` | — | AgentConfig。`groups/{name}/SKILLS/` からロードするスキル指定。未指定または `[]` はスキルなし、配列は指定スキルのみ、`"*"` は全スキル。channelで指定するとgroupの指定を完全置換 |
| `mounts` | — | AgentConfig。コンテナへの追加マウント設定。channelで指定するとgroupのmountsを完全置換 |

`sessionMode` の詳細は `CLAUDE.md` を参照。通常のDiscord会話におけるAgentConfigの解決順は `group → channel`、cron jobにおける解決順は `group → cron job` である。cronの `channelId` は配送先を指定するためだけに使われ、通常チャンネルIDでも既存スレッドIDでもchannelのAgentConfigは継承しない。未指定フィールドは親を継承し、指定フィールドはモデルオブジェクトや配列を含めて完全置換する。`tools` / `skills` / `mounts` の暗黙加算やdeep mergeは行わない。したがって、groupやcron jobで `subagent` を許可していても、channelやcron jobが `tools` を完全置換してその名前を含めなければ、実行時にsubagent toolは公開されない。`allowMention` / `toolLogArgs` はgroup限定で、AgentConfigには含まれない。

### 起動時Discord履歴バックフィル

設定済みの全チャンネルで、ボット停止中にDiscordへ届いたメッセージを起動時にDiscord APIから取得し、通常のinboxへ投入する。バックフィルは常に有効で、`MessageCreate` と同じ取り込み処理を通る。

初回起動時は現在の最新メッセージをカーソルとして登録するため、既存履歴を遡らない。以降は `data/runtime.sqlite` の `discord_sync_cursors` に保存したカーソルより後を取得する。既存スレッドの復旧ではアーカイブ済みスレッドも対象に含める。

ライブ受信とバックフィルの両方でDiscordメッセージIDを冪等キーに使うため、起動処理と通常イベントが競合しても二重投入されない。バックフィルではbot/Webhookメッセージを対象外とし、過去RSSの再処理は行わない。

`shared` は親チャンネル、`thread` は既存スレッド、`auto-thread` は親メッセージごとのスレッド作成・再利用を対象にする。スレッド作成にはDiscord側のスレッド作成権限、履歴取得にはメッセージ履歴の閲覧権限が必要。

`skills` は安全側に倒し、キー自体を省略した場合もスキルはロードしない。`groups/{name}/SKILLS/` 配下の全スキルをロードしたい場合だけ `"skills": "*"` を明示する。

## groups/{name}/AGENTS.md

グループのシステムプロンプト。新しいグループフォルダが存在しない場合、`ensureGroupDirs`（`src/config/group-config.ts`）が起動時に `templates/group/AGENTS.md` を `groups/{name}/AGENTS.md` としてコピーして作成する。

- `templates/group/AGENTS.md` にはこの自動コピーの都合上、汎用的な共通ルールのみを書く。グループ固有のチューニング（役割説明・固有ルール・出力フォーマット等）はコピー後に各グループの `AGENTS.md` へ追記する
- AGENTS.md を置くと組み込みのデフォルトシステムプロンプトは完全に置き換えられるため、共通ルールはテンプレート側にも持たせている
- 利用可能なツール一覧は API 経由で自動注入されるため、テンプレートやグループ側の AGENTS.md にツール名を列挙しない（`config/groups.json` の変更やツール改名で内容が嘘になるため）。書くのは「どう振る舞うか」だけにする

## config/cron.json

定期実行ジョブの定義。トップレベルは配列。ファイル自体が存在しない場合も cron は空扱いで起動する（空配列の場合と同じ挙動）。
詳細は `docs/spec/cron.md` を参照。

```json
[
  {
    "id": "mail-check",
    "schedule": "*/30 * * * *",
    "enabled": true,
    "deliveryMode": "new-thread",
    "sessionMode": "destination",
    "handler": "jobs/mail.ts"
  },
  {
    "id": "cheap-daily-summary",
    "schedule": "0 9 * * *",
    "enabled": true,
    "groupName": "my-group",
    "prompt": "昨日の要点を短くまとめてください",
    "channelId": "YOUR_CHANNEL_ID",
    "deliveryMode": "direct",
    "sessionMode": "per-run",
    "model": { "provider": "zai", "modelId": "glm-4.7-flash" },
    "tools": ["read"],
    "skills": ["session-logs"]
  }
]
```

宣言的ジョブ（`handler` を使わず `groupName`/`prompt`/`channelId`/`deliveryMode`/`sessionMode` を指定する形式）では、投稿方法とセッションの扱いを別々に設定する。

| フィールド | 値 | 動作 |
|---|---|---|
| `deliveryMode` | `direct` | `channelId` へ直接投稿する。通常チャンネルだけでなく既存スレッドのIDも指定可能 |
| `deliveryMode` | `new-thread` | `channelId` を親として実行ごとに新しいスレッドを作成する |
| `deliveryMode` | `item-thread` | 一時sessionでAIを実行し、応答がある場合だけ親メッセージを投稿してmessage/thread IDへsessionを昇格してから1項目用スレッドを作成する。`sessionMode` は `destination` 必須 |
| `sessionMode` | `per-run` | cron実行ごとに独立したセッションIDを生成する |
| `sessionMode` | `destination` | 実際の投稿先チャンネルまたはスレッドのIDをセッションIDにする |
| `noReply` | `true` | このcronリクエストのsystem promptへ、通知不要時に独立行 `<NO_REPLY>` を返す指示を追加する。`item-thread`でも利用可能 |

独立行 `<NO_REPLY>` の応答は通常会話、および`direct`/`new-thread`/`item-thread` cronで正常完了し、Discordへ配送しない。inlineの言及は通常どおり配送する。`noReply`の既定値は`false`で、AGENTS.mdなどに同じ指示を書く場合は不要。`item-thread`はAI実行後までDiscord状態を作らないため、NO_REPLY時は親メッセージもthreadも作成しない。Mail/RSSは無配信時も処理済みとしてsourceを確定する。Mailの既読化に失敗した場合は未読のまま次回cronで再取得し、RSSの確定に失敗した場合はclaimを解放して次回cronで再取得する。`new-thread` + `destination` は既存のsession ID契約を守るためAI実行前にスレッドを作るので、NO_REPLY時は投稿のないスレッドが残る。

既存スレッドへ投稿しつつ毎回セッションを分離する場合は、`channelId` にスレッドID、`deliveryMode` に `direct`、`sessionMode` に `per-run` を指定する。`item-thread` は1項目ごとの独立スレッドを使うため `destination` と組み合わせる。旧 `mode` も後方互換のため読み込めるが、新しい設定では使用しない。`to-channel` は `direct` + `per-run`、`to-thread` は `new-thread` + `destination` として扱われる。

`model` / `tools` / `skills` / `mounts` を任意で指定すると、groupの既定値をそのジョブの実行時だけ上書きできる。cronの `channelId` は配送先だけを表し、配送先channelまたは既存threadのAgentConfigは継承しない。`skills` は配列、`[]`、`"*"` のいずれも指定できる。指定フィールドは完全置換で、モデルオブジェクトや配列のdeep merge・暗黙加算は行わない。上書きは cron 実行から生成される inbox メッセージにだけ付与され、通常の人間の会話や `config/groups.json` 自体には影響しない。`handler` 付きジョブは従来どおり `settings` 経由でハンドラー側が自由に扱う。`allowMention` / `toolLogArgs` はgroup設定のみで、cron jobからは変更できない。

### jobs/mail.ts

`mail.ts` は未読メールごとに本文とACK対象のメールIDを取得し、`enqueueCronInbox()` へ投入する。`deliveryMode` / `sessionMode` はcron設定に従って共通のcron enqueue/pollerが処理するため、`mail.ts` は `direct`・`new-thread`・`item-thread` のいずれも制限しない。全delivery chunkが`sent`になった後にだけメールを既読化する。ACK対象を特定するメールID以外のmail固有冪等キー、source照合、placeholder/threadのcross-run再利用は行わない。

AI・delivery・既読化の失敗時はメールが未読のまま残る。次回cronは過去jobを復旧せず、そのメールに新しいjobと投稿先を作るため、失敗した試行のDiscord投稿が残る場合は重複しうる。これはmailの既知の残余リスクとして扱い、RSS dispatchなど別目的の冪等性は維持する。

複数producerや複数ホストで同じメールソースを処理する協調は保証しない。

### jobs/rss-collect.ts / jobs/rss-dispatch.ts

RSS処理は収集とエージェント投入を分離する。`rss-collect.ts` はLLMを使わずRSS/Atomフィードの記事を `data/rss.sqlite3` に保存し、`rss-dispatch.ts` は未読記事をまとめて通常のエージェントinboxへ投入する。

対応形式をRSS 2.0とAtom 1.0へ絞る判断、公開フィード20件の実測結果、RSS 1.0 / RDFと非UTF-8の扱いは [RSSフィード形式の対応範囲調査](research/rss-format-support-audit.md) に記録している。以下は絞り込み前の現行実装について説明する。

```json
[
  {
    "id": "rss-collect",
    "schedule": "*/15 * * * *",
    "handler": "jobs/rss-collect.ts",
    "settings": {
      "feeds": ["https://example.com/feed.xml"],
      "bootstrap": "mark-seen"
    }
  },
  {
    "id": "rss-dispatch",
    "schedule": "5,20,35,50 * * * *",
    "groupName": "rss",
    "channelId": "YOUR_CHANNEL_ID",
    "prompt": "各記事のURLをagent-reachで取得し、日本語で要約してください",
    "deliveryMode": "direct",
    "sessionMode": "per-run",
    "handler": "jobs/rss-dispatch.ts",
    "tools": ["bash"],
    "skills": ["agent-reach"],
    "settings": {
      "feeds": ["https://example.com/feed.xml"],
      "maxItemsPerRun": 10,
      "maxSummaryChars": 4000
    }
  }
]
```

Collectorの`feeds`にはURL文字列、または `{ "name": "表示名", "url": "URL" }` を指定できる。ETagとLast-Modifiedが返るフィードでは条件付き取得を使用する。`bootstrap`の既定値は`mark-seen`で、初回に掲載されていた記事を既読として保存する。`process`にすると初回記事も未読で保存する。

Collectorが取得するRSS本文の上限は5 MiBで、現在は設定から変更できない。これはRSS/Atomとしての妥当性ではなく、取得先の誤設定や侵害による過大なメモリ消費を防ぐための運用上限である。`Content-Length`がない場合や実際より小さい場合も、本文を読みながら上限を検査し、超過した時点で取得を中断する。正当なフィードであっても5 MiBを超えるものは収集対象にできない。

記事数には上限を設けず、解析した全記事を1トランザクションでSQLiteへ保存する。

フィード形式の解釈には、RSS/RDF/Atomの正規化、`xml:base`を含む相対URL解決、Atom XHTML処理を備えた`feedparser`を使用する。文字コード判定は`encoding-sniffer`へ委譲し、BOM、XML宣言、HTTP `Content-Type`の`charset`を反映する。汎用XMLパーサー上でこれらのフィード仕様を独自に実装しない方針とし、UTF-16、Shift_JIS、HTTP charset、相対URL、階層的`xml:base`、Atom XHTMLを回帰テストで固定する。

選定時には`feedsmith`、`@rowanmanning/feed-parser`、`feedparser`を同じAtom入力で比較した。`feedsmith`は相対URLとXHTMLマークアップを保持したまま返し、`@rowanmanning/feed-parser`はXHTMLをテキスト化できるが最終レスポンスURLを解析時のベースURLとして渡せなかった。`feedparser`は`feedurl`オプションと階層的`xml:base`処理によって両方を満たすため採用した。ライブラリ自身はHTTP取得を行わず、Collectorが上限内で取得した本文だけを渡す。

Dispatcherは`maxItemsPerRun`件の未読記事を1つのinboxメッセージへまとめる。`prompt`は必須で、記事の取得方法や要約形式もここに指定する。inboxにはこの`prompt`と記事情報だけを渡す。

Dispatcherの`settings.feeds`にはCollectorと同じURL文字列、または`{ "name": "表示名", "url": "URL" }`を指定でき、指定したフィードの未読記事だけを処理する。省略時は後方互換のため全フィードを処理する。複数Dispatcherを使う場合は全ジョブで`feeds`を指定し、対象URLが重複しないようにする。全件Dispatcherとフィード指定Dispatcherを同時に有効化すると、cronの並列実行時に同じ未読記事を重複投入する可能性がある。

`appendInbox`が成功した直後に、今回投入した記事だけを既読にする。この既読は「Discord配信済み」ではなく「エージェントへ引き渡し済み」を意味する。エージェント処理やDiscord配信が後から失敗してもRSS側からは再投入しない。inbox投入自体が失敗した場合は未読のまま残る。

`maxSummaryChars`は記事ごとにinboxへ含めるRSS概要の最大文字数。`model`、`tools`、`skills`も通常の宣言的cronと同じようにエージェント実行へ引き継がれる。CollectorとDispatcherが同時実行にならないよう、設定例では5分ずらしている。

### jobs/issue-triage.ts

GitHub Issue を定期的に棚卸しし、`issue-triage` グループ（`tools: ["bash", "list-issues", "read-issue", "comment-issue"]`）に判断・コメント投稿まで一貫して行わせるハンドラー。

```json
{
  "id": "issue-triage",
  "schedule": "0 * * * *",
  "enabled": true,
  "groupName": "issue-triage",
  "channelId": "YOUR_CHANNEL_ID",
  "handler": "jobs/issue-triage.ts",
  "settings": {
    "owner": "YOUR_GITHUB_USERNAME",
    "repo": "YOUR_REPO_NAME",
    "allowedAuthors": ["YOUR_GITHUB_USERNAME"]
  }
}
```

- `settings.owner`/`settings.repo`: 対象リポジトリ
- `settings.allowedAuthors`: 処理対象とする Issue 投稿者の許可リスト（省略時は `owner` のみ）。第三者が投稿した Issue は処理対象から除外し、issue本文への攻撃文によるプロンプトインジェクションの影響範囲を限定する
- 重複コメント防止のため、処理済み Issue 番号と `updated_at` を `data/issue-triage/state.json` に記録し、値が変化していなければ再処理しない。同一プロセス内でジョブが並行実行されても読み書きが直列化されるため、別リポジトリを対象にした複数の issue-triage ジョブを同時に動かしても state が失われない
- エージェントがコードを根拠付けに参照できるよう、`issue-triage` グループには `config/groups.json` の `mounts` でコードを読み取り専用マウントする想定（`config/groups.example.json` 参照）
  - **`host: "."`（リポジトリルートそのもの）は絶対にマウントしないこと。** `.env`（`DISCORD_BOT_TOKEN` 等）や `config/credentials.json` は git管理外（`.gitignore`）だが実ファイルとして存在するため、読み取り専用でもエージェントの `bash` から閲覧でき、`comment-issue` で公開Issueにそのまま漏洩しうる
  - 必ず、これらの機密ファイルを含まない別の場所（git clone した別ディレクトリ等）を用意し、その絶対パスを `mounts.host` に指定する

## config/config.json

`groups.json` / `credentials.json` / `cron.json` に分離されていない残りの設定。トップレベルはオブジェクト。

```json
{
  "bots": {
    "coding": {
      "group": "default",
      "instructions": "コード変更を担当する worker",
      "model": { "provider": "zai", "modelId": "glm-4.7-flash" },
      "tools": ["read", "write", "edit"],
      "skills": [],
      "mounts": []
    }
  },
  "defaultModel": { "provider": "zai", "modelId": "glm-4.7-flash" },
  "proxy": { "requestTimeoutMs": 120000 },
  "agent": { "timeoutMs": 600000 }
}
```

| キー | 必須 | 内容 |
|---|---|---|
| `bots` | — | 名前付き Bot profile の map。各 profile は `group` と空でない `instructions`（ともに必須）、AgentConfig（`model` / `tools` / `skills` / `mounts`）を持つ |
| `defaultModel` | ✓ | `groups[].model` 省略時に使うデフォルトモデル（`provider`/`modelId`） |
| `proxy` | — | `requestTimeoutMs`: クレデンシャルプロキシの upstream リクエストタイムアウト（ms、デフォルト: 120000） |
| `agent` | — | `timeoutMs`: エージェントプロセス（サンドボックスコンテナ）のタイムアウト（ms、デフォルト: 600000＝10分） |

Botのauthority modelと、`bot` capabilityを明示的に許可する理由は [エンティティモデルのauthority境界](spec/entity-model.md#agentgroupとbotのauthority境界) を参照。`bots` の `group` は Bot が所属する AgentGroup の trust/context boundary を指定する。Bot profile の AgentConfig はその group の設定を上書きし、channel の設定は継承しない。Bot profile の effective `model` / `tools` / `mounts` は起動時に検証され、不正な設定があれば Discord client 初期化前に起動を停止する。Discordでは `/bot` コマンドに `bot` を指定し、`action`（`run` / `resume` / `list`）を選択できる。`run`（action省略時も同じ）は `prompt` で新しいTask Sessionを作成し、応答に表示された `session` handleを `resume` で明示指定すると同じ仕事を続行できる。`list` は現在のAgentGroupとBotが所有するTask Sessionだけを表示する。Botの実行は通常のキュー・sandbox・Discord配送経路を利用するが、Task Sessionの履歴・添付領域は呼び出し元の通常channel/thread sessionから分離され、応答の配送先だけが呼び出しchannel/threadに残る。メインAgentには同じBot Registryを呼び出す組み込み `bot` toolが、effective `tools` に正確な名前 `bot` を明示した場合だけ提供され、`action=run|resume|list` を指定できる。Bot profileやqueued/direct Bot childの実行では再帰的な `bot` toolを常に無効化する。`run` / `resume` はキューへ積まず、同じtool call内でsandbox実行の完了まで待って結果を返す（非同期handle返却やpollingは行わない）。親Agentが現在保持しているものと同じserial providerをBotが使い、対象Task Sessionに先行処理がある場合は、deadlockを避けるため同期Bot呼び出しを待機せず拒否する。親が保持していないproviderでも、異なるserial providerを対象とする場合は既存のdeadlock防止ガードにより拒否する。parallel providerは通常どおり実行する。Bot Task Sessionのqueued/direct実行はruntime.sqliteの同じordered jobs/direct-admission ledgerで直列化され、agent toolとDiscordの`/bot`が同じTask Sessionを同時にresumeしても履歴を同時更新しない。プロセス起動時は管理対象コンテナ（現行labelと旧形式の名前のものを含む）の停止を確認した後、前回プロセスの未完了admissionとqueue実行を回収する。Dockerのdiscoveryまたは停止確認に失敗した場合は起動を中止し、実行状態を回収しない。

## 環境変数

| 変数 | 用途 |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord Bot トークン（必須） |
| `CONFIG_PATH` | `config/config.json` のパスを上書きする（省略時はプロジェクトルートの `config/config.json`） |
| `PROVIDERS_PATH` | `config/providers.json` のパスを上書きする |
| `CREDENTIALS_PATH` | `config/credentials.json` のパスを上書きする |
| `GROUPS_PATH` | `config/groups.json` のパスを上書きする |
| `CRON_PATH` | `config/cron.json` のパスを上書きする |

API キーなどプロバイダー固有の変数は `.env.example` を参照。

## 再起動なしに反映されるか

| 設定 | 反映タイミング |
|---|---|
| `credentials` | 再起動が必要（起動時に読み込みキャッシュ） |
| `groups` | 再起動が必要（起動時に読み込みキャッシュ） |
| `cron` | 再起動が必要（起動時に読み込みキャッシュ） |

`credentials` と `groups` は起動時に読み込みに失敗すると `process.exit(1)` するため、修正後は再起動が必要（`config/credentials.json` / `config/groups.json` 自体が存在しない場合も同様にエラーで起動失敗する）。

`cron` は起動時に `loadAndValidateCron()` が一度だけ読み込んだ結果をメモリ上の `_jobs` にセットし、`tick()` はそれを毎分参照するだけでファイルの再読み込みは行わない。そのため一度起動した後は `config/cron.json` を変更しても再起動するまで反映されない（`docs/spec/cron.md` と同じ）。

`config/cron.json` は省略可能な設定のため、起動時に存在しなくても `loadAndValidateCron()` はエラーにせず空配列を返し、cron が空扱いで起動する。ただしこの場合も後から `config/cron.json` を配置しても再起動しない限り反映されない。`config/credentials.json` / `config/groups.json` は必須設定のため、欠落時は process.exit(1) で起動自体が止まる点が異なる。

## 変更履歴

### groups/{name}/group.json の統合（#93）

旧: `groups/{name}/group.json` にモデル・ツール・allowMention・toolLogArgs・skills を設定
新: グループ設定ファイル（現在は `config/groups.json`）の `groups[].model` / `groups[].tools` / `groups[].allowMention` / `groups[].toolLogArgs` / `groups[].skills` に統合

**理由**: `groups/{name}/` はサンドボックスコンテナに `/workspace` として書き込み可能でマウントされるため、`group.json` をそこに置くとエージェント自身がモデルやツールの設定を書き換えられてしまう。コンテナにマウントされない設定ファイル側に移すことでこれを防ぐ。

### config ファイルの統合（#76）

旧: `config/groups.json` / `config/cron-jobs.json` / `config/credential-proxy.json` の3ファイル
新: `config/config.json` に `groups` / `cron` / `credentials` キーとして統合

**Breaking change**: `CREDENTIAL_PROXY_PATH` 環境変数を廃止。パスの上書きは `CONFIG_PATH` で行う。

### config ファイルの再分割（#137）

旧: `config/config.json` 1ファイルに `defaultModel` / `credentials` / `groups` / `cron` / `poller` を統合
新: `config/credentials.json` / `config/groups.json` / `config/cron.json` を独立ファイルに再分割し、`config/config.json` には共通設定のみ残す。その後、provider 実行ポリシーは `config/providers.json` に分離した

**理由**: 単一ファイルに役割の異なる設定（機密情報の `credentials`、人手で頻繁に編集する `groups`、運用上省略可能な `cron`）が混在しており、ファイル単位での差分管理・パス上書きがしづらかった。

**Breaking change**: 後方互換なし。既存の `config/config.json` から `credentials` / `groups` / `cron` の各キーを手動で `config/credentials.json` / `config/groups.json` / `config/cron.json` に分離する必要がある。パスの上書きはそれぞれ `CREDENTIALS_PATH` / `GROUPS_PATH` / `CRON_PATH` で行う。
