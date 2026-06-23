# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## コマンド

```bash
pnpm dev          # tsx で開発実行（ホットリロードなし）
pnpm build        # tsc でビルド → dist/
pnpm start        # dist/index.js を実行
pnpm test         # vitest run（全テスト）
pnpm typecheck    # tsc --noEmit
pnpm lint         # biome lint src/
pnpm check        # biome check --write src/（lint + format 同時）
```

単一テストファイルの実行:
```bash
pnpm vitest run src/queue/poller.test.ts
```

## アーキテクチャ

メッセージはDiscordイベント → インボックスキュー → ポーラー → エージェントという非同期パイプラインで処理される。

```
【ホストプロセス】
Discord受信
  └─ discord/handler.ts   (MessageCreateイベント)
       └─ queue/inbox.ts  (appendInbox: data/queue/inbox.jsonl へ追記)
            └─ queue/poller.ts (1秒ごとに shiftInbox() でデキュー)
                 ├─ agent/manager.ts  (sendMessage: サンドボックスコンテナを起動)
                 │    ├─ agent/session.ts  (会話履歴を data/sessions/{group}/{sessionId}.jsonl に JSONL 永続化)
                 │    └─ config/group-config.ts (groups/{name}/group.json + AGENTS.md をキャッシュ読み込み)
                 └─ discord/client.ts  (返信送信)

【サンドボックスコンテナ（Dockerコンテナ内）】
  └─ sandbox/agent-runner.ts  (Agent ループ実行)
       └─ tools/registry.ts   (bashTool・agentReachTool など全ツールを登録・実行)
```

### ツール実装の原則

**すべてのツール（`src/tools/`）はサンドボックスコンテナ内で実行される。** ホスト側では実行されない。

新しいツールを追加する場合:
- `src/tools/` に実装し、`src/tools/registry.ts` に登録する
- ホスト側のファイルシステムやプロセスに直接アクセスするAPIは使わない
- コンテナ内の `/workspace` を作業ディレクトリとして使う

### 重要な設計判断

**チャンネルロック（poller.ts の `channelChain`）**: 同一チャンネルへのメッセージは順番通りに処理、異なるチャンネルは並列実行。

**インボックスのファイルミューテックス（inbox.ts の `withFileLock`）**: `readFile→writeFile` 間に `appendInbox` が割り込むとメッセージが消失するため、Promise チェーンで全ファイル操作を直列化している。

**エージェントの使い捨て生成（manager.ts）**: `Agent` はリクエストごとに JSONL から履歴を読み込んで生成し、終了後は破棄。ステートレスにすることでセッション管理を単純化している。

**キャッシュ戦略（group-config.ts）**: `initGroupConfigs()` で起動時に全グループ設定を一括ロードしてメモリキャッシュ。再起動するまでファイルの変更は反映されない。

### sessionMode

`config/groups.json` で各チャンネルに設定:
- `shared`: チャンネル全体で1セッション（スレッド内メッセージは無視）
- `thread`: 既存スレッド内のメッセージのみ処理（スレッドIDがセッションID）
- `auto-thread`: 非スレッドメッセージで自動スレッド作成、スレッド内は継続会話

### ファイルシステム構造

```
config/groups.json          # チャンネル→グループのマッピング（Zodで検証）
groups/{name}/
  group.json                # モデル・ツール・autoReply・toolLogArgs 設定（省略可）
  AGENTS.md                 # グループのシステムプロンプト（省略可）
  SKILLS/{skill}/SKILL.md   # グループ固有のスキル定義（省略可）
src/cron/jobs/*.ts          # 共有 cron ハンドラー（コミット対象。mail.ts 等のサンプル）
src/cron/jobs/local/*.ts    # 個人ワークフロー固有の cron ハンドラー（gitignore）
data/queue/inbox.jsonl      # 処理待ちメッセージキュー（自動生成）
data/queue/dead-letter.jsonl# リトライ上限超えたメッセージ（自動生成）
data/sessions/{group}/{sessionId}.jsonl  # 会話履歴（自動生成）
```

cron ハンドラーの置き場は `src/cron/jobs/local/` を gitignore し、機構（`src/cron/`）・共有サンプルと個人ジョブを分離している。`local/` を `src/` 配下に置くのは必須で、`tsconfig.json` の `include: ["src/**/*"]` 上 `tsc` が `src/` 外をコンパイルせず、prod（`pnpm start`）で `loadHandlerFn` が `dist/` の `.js` を import できなくなるため。ジョブ定義（`cron` 配列・`handler` パス）は gitignore 済みの `config` 側に書く。

### 環境変数

`.env.example` を `.env` にコピーして設定:
- `DISCORD_BOT_TOKEN`: Discord Bot トークン
- `ZAI_API_KEY`: zAI（推奨デフォルト。glm-4.7-flash は無料枠で並列実行1まで利用可能）の API キー

その他のプロバイダー環境変数は `.env.example` のコメントを参照。クレデンシャルプロキシの詳細は `docs/proxy.md` を参照。

## テストの注意点

`group-config.ts` / `config/config.ts` などモジュールレベルキャッシュを持つファイルのキャッシュをテスト間でリセットするには `vi.resetModules()` + dynamic import を使う（プロダクションコードに `_resetCache()` を生やさない）。

## 参照クローン（`docs/clone/`）

設計判断の根拠として4つのクローンを保持している。コード変更前に関連するパターンを確認すること。

### nanoclaw（`docs/clone/nanoclaw/`）

- **出典**: qwibitai/nanoclaw — コンテナ分離型パーソナルAIエージェントのOSS
- **アーキテクチャ**: Node.jsホスト + Bunコンテナ（2プロセス）。セッションごとに `inbound.db` / `outbound.db` の2つのSQLiteで分離。ホストとコンテナ間はDBのみで通信（IPC・stdin不使用）
- **チャンネル**: スキル（`/add-discord` 等）でインストール。バレルインポートで自己登録するファクトリーパターン
- **クレデンシャル**: OneCLI Agent Vault経由でコンテナに注入。envvarでは渡さない
- **参照すべき場面**: コンテナ分離・クレデンシャル安全挿入・チャンネル拡張パターンの実装時
- **詳細**: `docs/clone/nanoclaw/CLAUDE.md`、`docs/clone/nanoclaw/docs/SPEC.md`

### my-nanoclaw（`docs/clone/my-nanoclaw/`）

- **出典**: shin902がnanoclaw v2をフォークした個人用カスタマイズ版
- **アーキテクチャ**: 単一Node.jsプロセス。SQLiteでメッセージ保存、Claudeエージェントをコンテナ（Linux VM）で実行
- **メモリ**: `groups/{name}/CLAUDE.md`（グループ別）+ `groups/CLAUDE.md`（グローバル）の階層構造
- **参照すべき場面**: グループ別メモリ設計・スケジューラ実装・コンテナビルド設定の参照時
- **詳細**: `docs/clone/my-nanoclaw/CLAUDE.md`、`docs/clone/my-nanoclaw/docs/SPEC.md`

### nanobot（`docs/clone/nanobot/`）

- **出典**: HKUDS/nanobot — Pythonベースの超軽量AIエージェント（PyPI公開OSS）
- **特徴**: 設定ファイルベース（`~/.nanobot/config.json`）、マルチプロバイダ（OpenRouter・Anthropic・Gemini等）、Discord/Telegram/Slack等のマルチチャンネル対応
- **セッション**: チャンネルごとにスレッドベースのセッション分離
- **参照すべき場面**: セッションモードの実装パターン・マルチプロバイダ対応・スケジューラ設計の参照時
- **詳細**: `docs/clone/nanobot/README.md`、`docs/clone/nanobot/docs/`

### VRC-AI-Bot（`docs/clone/VRC-AI-Bot/`）

- **出典**: VRChat-AI集会向けDiscordボット（「ティラピコ」）
- **アーキテクチャ**: SQLiteマイグレーション管理（`migrations/`）、知識検索・URL監視機能あり、Codex実行環境
- **AGENTS.md設計**: bot-runtimeレイヤーとimplementationレイヤーを厳格に分離。`AGENTS.md`でペルソナ・返信先ルール・MUSTを宣言し、`implementation/AGENTS.md`をpre-edit gateとして扱う
- **返信先ルール**: `chat_reply`（same place）/`knowledge_ingest`（スレッド）/`ignore` の3分岐
- **参照すべき場面**: グループシステムプロンプト（`groups/{name}/AGENTS.md`）の設計・返信ルーティングロジックの参照時
- **詳細**: `docs/clone/VRC-AI-Bot/AGENTS.md`、`docs/clone/VRC-AI-Bot/implementation/`
