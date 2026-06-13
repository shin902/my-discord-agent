# 設定ファイルリファレンス

## 概要

すべての設定は `config/config.json` 1ファイルに集約されている。
`config/config.example.json` をコピーして作成し、環境に合わせて編集する。

```
config/
  config.json          # 統合設定（groups / credentials / cron）
  config.example.json  # テンプレート

groups/{name}/
  AGENTS.md            # グループのシステムプロンプト
```

グループのモデル・ツール・autoReply 等の設定は `config/config.json` の `groups` エントリに含まれる（`groups/{name}/` はコンテナに書き込み可能な領域としてマウントされるため、エージェント自身が変更できる設定値を置かないようにしている）。

## config/config.json の構造

```json
{
  "credentials": [...],
  "groups": [...],
  "cron": []
}
```

| キー | 必須 | 内容 |
|---|---|---|
| `credentials` | ✓ | AI プロバイダー・外部サービスの接続設定 |
| `groups` | ✓ | チャンネル → グループのマッピング |
| `cron` | — | 定期実行ジョブ定義（省略時は空配列） |

## credentials

AI プロバイダーや外部サービス（Microsoft Graph・Browserless 等）の接続設定。
詳細は `docs/config/credential-proxy.md` を参照。

```json
"credentials": [
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

## groups

チャンネル ID とグループ名・セッションモードのマッピングに加えて、グループごとのエージェント設定（モデル・ツール・autoReply 等）。

```json
"groups": [
  {
    "name": "chat",
    "model": { "provider": "opencode-go", "modelId": "kimi-k2.6" },
    "tools": ["tavily_search"],
    "autoReply": false,
    "toolLogArgs": true,
    "channels": [
      { "channelId": "111", "sessionMode": "shared" }
    ]
  },
  {
    "name": "thread",
    "model": { "provider": "opencode-go", "modelId": "kimi-k2.6" },
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
| `model` | — | `provider`/`modelId`/`thinkingLevel`。省略時は `DEFAULT_PROVIDER`/`DEFAULT_MODEL_ID` |
| `tools` | — | エージェントに渡す MCP ツール名の配列 |
| `autoReply` | — | Discord メッセージへの返信時に元メッセージへの reply 形式にするか |
| `toolLogArgs` | — | ツール実行ログに引数を含めるか |
| `skills` | — | `groups/{name}/SKILLS/` にロードするスキル名の配列 |
| `mounts` | — | コンテナへの追加マウント設定 |

`sessionMode` の詳細は `CLAUDE.md` を参照。エージェント設定（`model`/`tools`/`autoReply`/`toolLogArgs`/`skills`）はサンドボックスコンテナにマウントされない `config/config.json` 側で管理しており、エージェント自身が自分の設定を書き換えることはできない。

## cron

定期実行ジョブの定義。省略または空配列でも起動する。
詳細は `docs/spec/cron.md` を参照。

```json
"cron": [
  {
    "id": "mail-check",
    "schedule": "*/30 * * * *",
    "enabled": true,
    "handler": "jobs/mail.ts"
  }
]
```

## 環境変数

| 変数 | 用途 |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord Bot トークン（必須） |
| `CONFIG_PATH` | `config/config.json` のパスを上書きする（省略時はプロジェクトルートの `config/config.json`） |

API キーなどプロバイダー固有の変数は `.env.example` を参照。

## 再起動なしに反映されるか

| 設定 | 反映タイミング |
|---|---|
| `credentials` | 再起動が必要（起動時に読み込みキャッシュ） |
| `groups` | 再起動が必要（起動時に読み込みキャッシュ） |
| `cron` | 再起動が必要（起動時に読み込みキャッシュ） |

`credentials` と `groups` は起動時に読み込みに失敗すると `process.exit(1)` するため、修正後は再起動が必要。

`cron` は `loadRawConfig()` → `loadJobs()` の順でキャッシュされるため、一度読み込んだ後は再起動まで変更が反映されない（`docs/spec/cron.md` と同じ）。

**例外（ENOENT 時の自動回復）**: 起動時に `config.json` が存在しない場合、`loadRawConfig()` はエラーをスローして `_raw` をキャッシュしないため、後から `config.json` を配置すれば次の tick（最大1分）で cron が動き始める。ただしこれは `config.json` 自体が存在しない場合のみ。

## 変更履歴

### groups/{name}/group.json の統合（#93）

旧: `groups/{name}/group.json` にモデル・ツール・autoReply・toolLogArgs・skills を設定  
新: `config/config.json` の `groups[].model` / `groups[].tools` / `groups[].autoReply` / `groups[].toolLogArgs` / `groups[].skills` に統合

**理由**: `groups/{name}/` はサンドボックスコンテナに `/workspace` として書き込み可能でマウントされるため、`group.json` をそこに置くとエージェント自身がモデルやツールの設定を書き換えられてしまう。コンテナにマウントされない `config/config.json` 側に移すことでこれを防ぐ。

### config ファイルの統合（#76）

旧: `config/groups.json` / `config/cron-jobs.json` / `config/credential-proxy.json` の3ファイル  
新: `config/config.json` に `groups` / `cron` / `credentials` キーとして統合

**Breaking change**: `CREDENTIAL_PROXY_PATH` 環境変数を廃止。パスの上書きは `CONFIG_PATH` で行う。
