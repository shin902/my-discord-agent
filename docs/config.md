# 設定ファイルリファレンス

## 概要

設定は役割ごとに `config/` 配下の複数ファイルに分かれている。各ファイルは対応する `*.example.json` をコピーして作成し、環境に合わせて編集する。

```
config/
  config.json              # defaultModel・poller など上記以外の設定
  config.example.json
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
| `config/credentials.json` | ✓ | 配列 | AI プロバイダー・外部サービスの接続設定 |
| `config/groups.json` | ✓ | 配列 | チャンネル → グループのマッピング |
| `config/cron.json` | — | 配列（省略時は空扱い） | 定期実行ジョブ定義 |
| `config/config.json` | ✓ | オブジェクト | `defaultModel`（必須）・`poller`（省略可） |

> **`opencode-go` の `kimi-k2.6` は非推奨**: 大規模なツールコールで API エラーが頻発する問題が `pi-agent-core` の更新でも解消せず、他モデル（deepseek-v4 等）でも同様の報告がある（#107）。`zai` の `glm-4.7-flash` は無料枠（並列実行1まで・コンテキスト制限なし）で安定して動くため、`poller.dispatchMode: "serial"`（`docs/spec/poller-dispatch-mode.md` 参照）と組み合わせて使うことを推奨する。

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
    "provider": "llama-cpp-qwen3",
    "baseUrl": "http://localhost:8080/v1",
    "api": "openai-completions",
    "compat": { "thinkingFormat": "qwen-chat-template" }
  }
]
```

API キーなどの機密情報は `.env` に記載し、`envVars` で参照する。

## config/groups.json

チャンネル ID とグループ名・セッションモードのマッピングに加えて、グループごとのエージェント設定（モデル・ツール・autoReply 等）。トップレベルは配列。

```json
[
  {
    "name": "chat",
    "model": { "provider": "zai", "modelId": "glm-4.7-flash" },
    "tools": ["tavily_search"],
    "autoReply": false,
    "toolLogArgs": true,
    "channels": [
      { "channelId": "111", "sessionMode": "shared" }
    ]
  },
  {
    "name": "thread",
    "model": { "provider": "zai", "modelId": "glm-4.7-flash" },
    "tools": ["tavily_search", "agent-reach", "bash", "read", "write", "edit"],
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
| `skills` | — | `groups/{name}/SKILLS/` にロードするスキル名の配列 |
| `mounts` | — | コンテナへの追加マウント設定 |

`sessionMode` の詳細は `CLAUDE.md` を参照。エージェント設定（`model`/`tools`/`autoReply`/`toolLogArgs`/`skills`）はサンドボックスコンテナにマウントされない `config/groups.json` 側で管理しており、エージェント自身が自分の設定を書き換えることはできない。

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
  }
]
```

## config/config.json

`groups.json` / `credentials.json` / `cron.json` に分離されていない残りの設定。トップレベルはオブジェクト。

```json
{
  "defaultModel": { "provider": "zai", "modelId": "glm-4.7-flash" },
  "poller": { "dispatchMode": "serial" }
}
```

| キー | 必須 | 内容 |
|---|---|---|
| `defaultModel` | ✓ | `groups[].model` 省略時に使うデフォルトモデル（`provider`/`modelId`） |
| `poller` | — | `dispatchMode`（`docs/spec/poller-dispatch-mode.md` 参照） |

## 環境変数

| 変数 | 用途 |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord Bot トークン（必須） |
| `CONFIG_PATH` | `config/config.json` のパスを上書きする（省略時はプロジェクトルートの `config/config.json`） |
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

`cron` は `loadRawCron()` → `loadJobs()` の順でキャッシュされるため、一度読み込んだ後は再起動まで変更が反映されない（`docs/spec/cron.md` と同じ）。

**例外（ENOENT 時の自動回復）**: `config/cron.json` は省略可能な設定のため、起動時に存在しなくてもエラーにはならず cron が空扱いで起動する。`loadJobs()` は ENOENT 時に `_jobs` をキャッシュしないため、後から `config/cron.json` を配置すれば次の tick（最大1分）で cron が動き始める。`config/credentials.json` / `config/groups.json` はこの自動回復の対象外（必須設定のため、欠落時は process.exit(1) で起動自体が止まる）。

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
新: `config/credentials.json` / `config/groups.json` / `config/cron.json` を独立ファイルに再分割し、`config/config.json` には `defaultModel` / `poller` のみ残す

**理由**: 単一ファイルに役割の異なる設定（機密情報の `credentials`、人手で頻繁に編集する `groups`、運用上省略可能な `cron`）が混在しており、ファイル単位での差分管理・パス上書きがしづらかった。

**Breaking change**: 後方互換なし。既存の `config/config.json` から `credentials` / `groups` / `cron` の各キーを手動で `config/credentials.json` / `config/groups.json` / `config/cron.json` に分離する必要がある。パスの上書きはそれぞれ `CREDENTIALS_PATH` / `GROUPS_PATH` / `CRON_PATH` で行う。
