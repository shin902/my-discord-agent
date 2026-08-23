# my-discord-agent

Discord 上で動作する、サンドボックス分離型の AI エージェント Bot です。

Discord からの会話だけでなく、cron・RSS・メールなどのイベントも共通の永続キューへ流し、LLM 実行と Discord 配信を分離して処理します。

> 開発中の個人プロジェクトです。設定形式や内部構造は変更される可能性があります。

## 主な機能

- Discord チャンネル / スレッドでの AI エージェント会話
- 複数 Discord Bot と複数グループの設定
- グループごとのモデル・ツール・スキル・マウント設定
- Docker コンテナ内でのサンドボックス実行
- Credential Proxy による認証情報の隔離
- SQLite ベースの永続ジョブキュー
- Provider ごとの直列 / 並列実行制御
- cron による定期ジョブ
- RSS 収集・要約・Discord 配信
- メール取得、GitHub Issue triage などのカスタム cron handler
- 起動時の Discord 履歴 backfill、RSS reconciliation、runtime DB health check

## アーキテクチャ

```text
Discord / cron / RSS / mail
          │
          ▼
     persistent queue
          │
          ▼
        poller
          │
          ▼
  agent/manager.ts
          │
          ▼
┌──────────────────────────┐
│ sandbox container        │
│ agent-runner.ts          │
│   └─ tools / skills      │
└──────────────────────────┘
          │
          ▼
    delivery worker
          │
          ▼
       Discord
```

エージェントとツールは Docker コンテナ内で実行されます。ホスト側のファイルやプロセスへ直接アクセスさせるのではなく、必要なディレクトリだけを group ごとの mount として公開します。

LLM 実行結果と Discord 配信は分離されており、ジョブ状態は SQLite に保存されます。プロセス再起動時にもキューや配送状態を復旧できる構成です。

## 技術スタック

- **Language**: TypeScript / Node.js 22+
- **Discord**: discord.js
- **Agent SDK**: `@earendil-works/pi-agent-core`
- **Model API**: `@earendil-works/pi-ai`
- **Queue / State**: SQLite (`better-sqlite3`)
- **Sandbox**: Docker
- **Test**: Vitest
- **Lint / Format**: Biome

モデル Provider は設定で切り替えられます。現在のサンプルには zAI、Codex OAuth、OpenAI、Anthropic、llama.cpp などの実行方式が含まれています。

## 設定ファイル

`config/` 配下の example をコピーして使用します。

| ファイル | 必須 | 用途 |
| --- | --- | --- |
| `config/config.json` | Yes | Discord Bot、デフォルトモデル、timeout など |
| `config/groups.json` | Yes | チャンネル、モデル、tools、skills、mounts などの group 設定 |
| `config/credentials.json` | Yes | sandbox / proxy から利用する credential 定義 |
| `config/providers.json` | No | Provider ごとの concurrency 設定。省略時はデフォルト値を使用 |
| `config/cron.json` | No | cron job 定義 |

パスは `CONFIG_PATH`、`GROUPS_PATH`、`CREDENTIALS_PATH`、`PROVIDERS_PATH`、`CRON_PATH` で上書きできます。

### Discord Bot token

最低限 `.env` に `DISCORD_BOT_TOKEN` が必要です。

複数 Bot を使う場合は、`config/config.json` の `discord.bots.*.tokenEnv` に指定した環境変数も `.env` に追加してください。

例:

```json
{
  "discord": {
    "bots": {
      "public": { "tokenEnv": "DISCORD_PUBLIC_BOT_TOKEN" }
    }
  }
}
```

この場合は `.env` に `DISCORD_PUBLIC_BOT_TOKEN=...` も必要です。

## セットアップ

### 前提条件

- Node.js 22+
- pnpm
- Docker

### 1. 依存関係をインストール

```bash
pnpm install
```

### 2. 設定ファイルを作成

```bash
cp .env.example .env
cp config/config.example.json config/config.json
cp config/groups.example.json config/groups.json
cp config/credentials.example.json config/credentials.json

# 必要に応じて
cp config/providers.example.json config/providers.json
cp config/cron.example.json config/cron.json
```

`.env` と各 JSON を利用環境に合わせて編集してください。

### 3. ローカル OCI レジストリを起動

agent-runner イメージは `localhost:5050` のローカル OCI レジストリ経由で配布されます。

```bash
pnpm sandbox registry start
```

### 4. サンドボックスイメージを build / push

```bash
pnpm sandbox build
```

`src/sandbox/` やコンテナ内で使うコードを変更した場合は再ビルドしてください。

### 5. 起動

開発時:

```bash
pnpm dev
```

ビルドして起動する場合:

```bash
pnpm build
pnpm start
```

> `localhost:5050` のローカルレジストリは TLS・認証なしです。共有ホストや CI では利用せず、信頼できるローカル環境でのみ使用してください。

## cron / automation

`config/cron.json` を作成すると定期ジョブを有効化できます。

通常の prompt を指定して Agent を起動するジョブに加え、`handler` を指定した専用ジョブも利用できます。

現在の example には以下のような構成例があります。

- 日次 Agent レポート
- メールチェック
- RSS collect / dispatch
- Reddit cookie refresh
- GitHub Issue triage
- 日次 / 週次 memory 更新
- 月次 finance report / subscription reminder

詳細は `config/cron.example.json` と `src/cron/jobs/` を参照してください。

## 開発

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

ソースを自動修正する場合:

```bash
pnpm check
pnpm format
```

## ドキュメント

- [Credential Proxy](docs/proxy.md)
- [Research & Requirements](docs/research/README.md)
  - [pi-agent-core](docs/research/pi/core/pi-agent-core.md)
  - [pi-ai](docs/research/pi/ai/pi-ai.md)

## 参考リポジトリ

- [Agent-Reach](https://github.com/Panniantong/Agent-Reach) - agent-reach 設計の参考
