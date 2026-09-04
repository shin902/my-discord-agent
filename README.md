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
| `config/config.json` | Yes | Discord application、デフォルトモデル、timeout など |
| `config/bots.json` | No | Agent Bot profile Registry（省略時はBotなし） |
| `config/groups.json` | Yes | チャンネル、group/channelのAgentConfig（model、tools、approvalRequiredTools、skills、mounts）などの設定 |
| `config/credentials.json` | Yes | sandbox / proxy から利用する credential 定義 |
| `config/providers.json` | No | Provider ごとの concurrency 設定。省略時はデフォルト値を使用 |
| `config/cron.json` | No | cron job 定義とAgentConfig override |

AgentConfigの継承は実行経路ごとに分かれます。`approvalRequiredTools` は、effective `tools` に含まれる既知のhost capabilityへDiscord上の追加確認を挟む完全opt-in設定で、未指定または `[]` なら従来どおりapprovalなしです。public / multi-user環境ではapproval UIを安全境界にせず、危険なmutation capability自体を `tools` へ付与しないでください。詳細は [エージェントのツールとスキル](docs/agent-tools-skills.md#discord-tool-approvalopt-in) を参照してください。Discordの `/stop` は現在のgroup/sessionのactive Agentへcooperative abortを送り、短い猶予後だけrunnerを強制停止します。通常のDiscord会話は `group → channel`、cronは配送先のchannel/thread設定を参照せず `group → cron job` です。cronの `channelId` は配送先を指定するためだけに使われ、通常チャンネルIDと既存スレッドIDでAgentConfigの解決結果は変わりません。Bot profileは `group → bot` で解決され、channelの設定は継承しません。Discordの `/bot` コマンドは `action=run`（省略可）で新しいTask Sessionを作成し、`action=resume` と表示された `session` handleで明示的に続行できます。`action=list` では現在のgroupとBotが所有するTask Sessionのhandle、Bot名、作成日時、最終利用日時、previewを確認できます。メインAgentの組み込み `bot` toolからも、effective `tools` に正確な名前 `bot` を明示した場合だけ同じ `run` / `resume` / `list` を利用できます。toolの `run` / `resume` はキューへ積まず、同じtool call内でBotのsandbox実行完了まで待機して結果を返します。BotのTask Session履歴・添付領域は通常会話から分離され、返信だけは呼び出し元channel/threadへ配送されます。通常会話とcronで指定した `model` / `tools` / `approvalRequiredTools` / `skills` / `mounts` はフィールド単位で完全置換されます。親Agentがproviderを保持中にBotが異なるserial providerを対象とする場合は、deadlock防止のため同期Bot呼び出しを拒否します。同じserial providerをBotが対象とする場合は親のlockを再利用しますが、対象Task Sessionに先行処理があるとlock/orderのcycleを避けるため待機せず拒否します。parallel providerは通常どおり実行します。Bot Task Sessionのqueued/direct実行はruntime.sqliteの同一ordered jobs/direct-admission ledgerで直列化され、agent toolとDiscordの`/bot`が同じTask Sessionを同時にresumeしても履歴を同時更新しません。起動時は管理対象コンテナの停止を確認してから、前回の未完了admissionとqueue実行を回収します。

パスは `CONFIG_PATH`、`GROUPS_PATH`、`CREDENTIALS_PATH`、`PROVIDERS_PATH`、`CRON_PATH`、`BOTS_PATH` で上書きできます。

### Discord Bot token

`config/config.json` の `discord.bots` に Discord application ごとの `applicationId`（非機密）と `tokenEnv`（トークンを読む環境変数名）を設定します。デフォルト identity `personal` も通常の Bot entry として必須です。トークン値は設定ファイルへ書かず、`tokenEnv` で指定した環境変数を `.env` に追加してください。

```json
{
  "discord": {
    "bots": {
      "personal": {
        "applicationId": "YOUR_PERSONAL_DISCORD_APPLICATION_ID",
        "tokenEnv": "DISCORD_BOT_TOKEN"
      },
      "public": {
        "applicationId": "YOUR_PUBLIC_DISCORD_APPLICATION_ID",
        "tokenEnv": "DISCORD_PUBLIC_BOT_TOKEN"
      }
    }
  }
}
```

既存設定から移行する場合は、`DISCORD_APPLICATION_ID` を削除し、その値を `discord.bots.personal.applicationId` へ移し、`tokenEnv` を `DISCORD_BOT_TOKEN` にした `personal` entry を追加してください。

### Agent Bot profile

Agent Bot profile の canonical source は `config/bots.json` です。トップレベルに Bot ID をキーとする map を置き、各 profile に `group`、空でない `instructions`、任意の `model` / `tools` / `approvalRequiredTools` / `skills` / `mounts` を指定します。`config/config.json` の `discord.bots` は Discord application 設定であり、両者はmergeされません。Botを使わない場合は `config/bots.json` を作成せずに起動できます。

```bash
cp config/bots.example.json config/bots.json
```

`group` mismatchや不正なAgentConfigは起動時に検出され、Discord client初期化前に失敗します。既存の `config/config.json` にトップレベル `bots` がある場合は、その map を `config/bots.json` へ移してから `config/config.json` から削除してください。`discord.bots` はDiscord application設定なので移動せず、2つの `bots` map がmergeされることはありません。

## セットアップ

### 前提条件

- Node.js 22+
- pnpm
- Docker

既存の mise 環境でこのブランチを pull して更新した場合は、`pnpm` コマンドやサービスの再起動・更新操作を実行する前に、リポジトリ直下で Node.js を強制再インストールしてください。これにより `mise.toml` の Corepack 設定が既存の Node.js にも反映されます。

```bash
mise install --force node
```

### 1. 依存関係をインストール

```bash
pnpm install
```

### 2. 設定ファイルを作成

```bash
cp .env.example .env
cp config/config.example.json config/config.json
# Bot profileを使う場合のみ
cp config/bots.example.json config/bots.json
cp config/groups.example.json config/groups.json
cp config/credentials.example.json config/credentials.json

# 必要に応じて
cp config/providers.example.json config/providers.json
```

`.env` と各 JSON を利用環境に合わせて編集してください。

`config/cron.json` は省略できます。cron を使う場合は `config/cron.example.json` を参考に必要なジョブだけを設定してください。example には有効化済みのカスタム handler も含まれるため、そのままコピーして `pnpm dev` を実行するのではなく、不要なジョブを無効化し、開発時は handler パスを実在する `.ts` ファイルに合わせてください。

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

### 5. MemoryCore sidecarを起動（任意）

TencentDB Agent Memoryを使う場合は、公式MemoryCore imageをsidecarとして起動します。cloneや自前buildは不要です。

```bash
cp config/memory-core.example.yaml config/memory-core.yaml
# .env の MEMORY_CORE_LLM_API_KEY にproviderのAPI keyを設定し、
# TDAI_LLM_API_BASE_URLは必要に応じて接続先へ変更する
# MEMORY_CORE_GATEWAY_API_KEYも設定してから起動
pnpm memory-core up -d
memory_core_port="${MEMORY_CORE_PORT:-$(awk -F= '$1 == "MEMORY_CORE_PORT" { print $2; exit }' .env 2>/dev/null)}"
curl "http://127.0.0.1:${memory_core_port:-8420}/health"
```

停止・ログ確認:

```bash
pnpm memory-core down
pnpm memory-core logs -f memory-core
```

永続データはDocker volumeに保存されます。詳細と`agentMemory`の有効化手順は [docs/config.md](docs/config.md#memorycore-sidecarの起動) を参照してください。

### 6. 起動

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
