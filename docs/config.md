# 設定ファイルリファレンス

## 概要

設定は役割ごとに `config/` 配下の複数ファイルに分かれている。各ファイルは対応する `*.example.json` をコピーして作成し、環境に合わせて編集する。

```
config/
  config.json              # defaultModel・proxy・agent などの設定
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

グループのモデル・ツール・autoReply 等の設定は `config/groups.json` の各エントリに含まれる（`groups/{name}/` はコンテナに書き込み可能な領域としてマウントされるため、エージェント自身が変更できる設定値を置かないようにしている）。

| ファイル | 必須 | トップレベル形式 | 内容 |
|---|---|---|---|
| `config/providers.json` | — | 配列（省略時は全 provider が `serial`） | AI プロバイダーごとの同時実行ポリシー |
| `config/credentials.json` | ✓ | 配列 | AI プロバイダー・外部サービスの接続設定 |
| `config/groups.json` | ✓ | 配列 | チャンネル → グループのマッピング |
| `config/cron.json` | — | 配列（省略時は空扱い） | 定期実行ジョブ定義 |
| `config/config.json` | ✓ | オブジェクト | `defaultModel`（必須）・proxy・agent 設定 |

> **`opencode-go` の `kimi-k2.6` は非推奨**: 大規模なツールコールで API エラーが頻発する問題が `pi-agent-core` の更新でも解消せず、他モデル（deepseek-v4 等）でも同様の報告がある（#107）。`zai` の `glm-4.7-flash` は無料枠（並列実行1まで・コンテキスト制限なし）で安定して動く。プロバイダー同時実行のデフォルトは `serial` のため、`zai` は追加設定なしでも安全に利用できる。

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

API キーなどの機密情報は `.env` に記載し、`envVars` で参照する。Codex OAuth / CLIProxyAPI の詳しい構成は `docs/codex-oauth-cliproxyapi.md` を参照。

### X Article Reader

`agent-reach` スキルで X Article を読む場合は、host 側で reader を起動し、Credential Proxy の `x-article` provider から Bearer token を注入する。

```bash
X_ARTICLE_READER_TOKEN=<十分に長いランダム値> node dist/proxy/x-article-reader.js
X_ARTICLE_READER_TOKEN=<十分に長いランダム値> X_ARTICLE_READER_MOCK=1 node dist/proxy/x-article-reader.js
```

通常モードの reader は `data/x-cookies.json`（または `X_ARTICLE_COOKIE_FILE` / `X_COOKIE_FILE`）を読み、X 内部 GraphQL を呼ぶ。初回の cookie ファイルはブラウザ Cookie DB から `pnpm x:cookie:from-browser --source firefox --profile-dir ~/.mozilla/firefox/xxxx.default-release` で作る。DevTools 等で取得した X の Cookie request header を `pbpaste | pnpm x:cookie:import` で保存することもできる。

## config/groups.json

チャンネル ID とグループ名・セッションモードのマッピングに加えて、グループごとのエージェント設定（モデル・ツール・autoReply 等）。トップレベルは配列。

```json
[
  {
    "name": "chat",
    "model": { "provider": "zai", "modelId": "glm-4.7-flash" },
    "tools": ["tavily-search"],
    "autoReply": false,
    "toolLogArgs": true,
    "channels": [
      { "channelId": "111", "sessionMode": "shared" }
    ]
  },
  {
    "name": "thread",
    "model": { "provider": "zai", "modelId": "glm-4.7-flash" },
    "tools": ["tavily-search", "bash", "read", "write", "edit"],
    "skills": ["session-logs"],
    "autoReply": true,
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
| `model` | — | `provider`/`modelId`/`thinkingLevel`。省略時は `config/config.json` トップレベルの `defaultModel` |
| `tools` | — | エージェントに渡す MCP ツール名の配列 |
| `autoReply` | — | Discord メッセージへの返信時に元メッセージへの reply 形式にするか |
| `toolLogArgs` | — | ツール実行ログに引数を含めるか |
| `skills` | — | `groups/{name}/SKILLS/` からロードするスキル指定。未指定または `[]` はスキルなし、配列は指定スキルのみ、`"*"` は全スキル |
| `mounts` | — | コンテナへの追加マウント設定 |

`sessionMode` の詳細は `CLAUDE.md` を参照。エージェント設定（`model`/`tools`/`autoReply`/`toolLogArgs`/`skills`）はサンドボックスコンテナにマウントされない `config/groups.json` 側で管理しており、エージェント自身が自分の設定を書き換えることはできない。

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
| `sessionMode` | `per-run` | cron実行ごとに独立したセッションIDを生成する |
| `sessionMode` | `destination` | 実際の投稿先チャンネルまたはスレッドのIDをセッションIDにする |

既存スレッドへ投稿しつつ毎回セッションを分離する場合は、`channelId` にスレッドID、`deliveryMode` に `direct`、`sessionMode` に `per-run` を指定する。旧 `mode` も後方互換のため読み込めるが、新しい設定では使用しない。`to-channel` は `direct` + `per-run`、`to-thread` は `new-thread` + `destination` として扱われる。

`model` / `tools` / `skills` を任意で指定すると、そのジョブの実行時だけ `config/groups.json` のグループ既定値を上書きできる。`skills` は配列、`[]`、`"*"` のいずれも指定できる。上書きは cron 実行から生成される inbox メッセージにだけ付与され、通常の人間の会話や `config/groups.json` 自体には影響しない。`handler` 付きジョブは従来どおり `settings` 経由でハンドラー側が自由に扱う。

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
  "defaultModel": { "provider": "zai", "modelId": "glm-4.7-flash" },
  "proxy": { "requestTimeoutMs": 120000 },
  "agent": { "timeoutMs": 600000 }
}
```

| キー | 必須 | 内容 |
|---|---|---|
| `defaultModel` | ✓ | `groups[].model` 省略時に使うデフォルトモデル（`provider`/`modelId`） |
| `proxy` | — | `requestTimeoutMs`: クレデンシャルプロキシの upstream リクエストタイムアウト（ms、デフォルト: 120000） |
| `agent` | — | `timeoutMs`: エージェントプロセス（サンドボックスコンテナ）のタイムアウト（ms、デフォルト: 600000＝10分） |

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

旧: `groups/{name}/group.json` にモデル・ツール・autoReply・toolLogArgs・skills を設定
新: グループ設定ファイル（現在は `config/groups.json`）の `groups[].model` / `groups[].tools` / `groups[].autoReply` / `groups[].toolLogArgs` / `groups[].skills` に統合

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
