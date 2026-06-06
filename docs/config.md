# 設定ファイルリファレンス

## 概要

すべての設定は `config/config.json` 1ファイルに集約されている。
`config/config.example.json` をコピーして作成し、環境に合わせて編集する。

```
config/
  config.json          # 統合設定（groups / credentials / cron）
  config.example.json  # テンプレート

groups/{name}/
  group.json           # グループ固有の設定（モデル・ツール・autoReply 等）
  AGENTS.md            # グループのシステムプロンプト
```

`groups/{name}/group.json` はグループの「部屋」（AGENTS.md と同居）なので統合対象外。

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

チャンネル ID とグループ名・セッションモードのマッピング。

```json
"groups": [
  {
    "name": "chat",
    "channels": [
      { "channelId": "111", "sessionMode": "shared" }
    ]
  },
  {
    "name": "thread",
    "channels": [
      { "channelId": "222", "sessionMode": "thread" },
      { "channelId": "333", "sessionMode": "auto-thread" }
    ]
  }
]
```

`name` は `groups/{name}/` ディレクトリ名と対応する。
`sessionMode` の詳細は `CLAUDE.md` を参照。

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

## 変更履歴

### config ファイルの統合（#76）

旧: `config/groups.json` / `config/cron-jobs.json` / `config/credential-proxy.json` の3ファイル  
新: `config/config.json` に `groups` / `cron` / `credentials` キーとして統合

**Breaking change**: `CREDENTIAL_PROXY_PATH` 環境変数を廃止。パスの上書きは `CONFIG_PATH` で行う。
