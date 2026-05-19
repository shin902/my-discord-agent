# my-discord-agent

Discord上で動作するAIエージェントボット。

## 概要

my-nanoclawプロジェクトの失敗を教訓に、"確実に動く"ことを保証しながら実装を進めています。E2Eテストを含めた堅実な開発アプローチを取っています。

## 主な機能

- Discordスレッドごとのチャット対応
- URL共有時の自動スレッド作成・応答
- サンドボックス実行環境（Dockerコンテナ内でエージェントとツールを実行）
- クレデンシャルプロキシ（`docs/spec/proxy.md` を参照）

## アーキテクチャ

ホストプロセスとサンドボックスコンテナの2層構造になっています。

```
【ホストプロセス】
Discord受信 → キュー → agent/manager.ts → サンドボックスコンテナを起動

【サンドボックスコンテナ（Docker）】
sandbox/agent-runner.ts → Agent ループ → tools/（bash・url-fetch など）を実行
```

**ツールは全てコンテナ内で実行されます。** ホスト側のファイルシステムやプロセスには直接アクセスしません。

## 技術スタック

- **Agent SDK**: pi-agent-core
- **Model Provider**: OpenCode Go
- **Platform**: Discord

## セットアップ

### 前提条件

- Node.js 22+
- pnpm
- Docker

### ローカルレジストリの起動（初回のみ）

agent-runner イメージは `localhost:5050` のローカル OCI レジストリ経由で配布されます。
microsandbox は Docker のローカルイメージストアを参照できないため、このレジストリが必須です。

```bash
docker run -d -p 5050:5000 --name local-registry registry:2
```

### agent-runner イメージのビルド・push

agent-runner のソースを変更した際は以下を実行してください。

```bash
pnpm runner:image:build
# esbuild バンドル → docker build → localhost:5050 へ push まで一括実行
```

### 通常の起動

```bash
cp .env.example .env   # 環境変数を設定
pnpm dev
```

> **Note**: ローカルレジストリ（`localhost:5050`）は TLS・認証なし。
> 共有ホストや CI 環境では他プロセスによる偽イメージ push のリスクがあるため、
> 信頼できる環境でのみ使用してください。

## ドキュメント

- [Research & Requirements](docs/research/README.md) - 技術調査・要件定義・選定理由
    - [pi-agent-core](docs/research/pi/core/pi-agent-core.md)
    - [pi-ai](docs/research/pi/ai/pi-ai.md)
    - [droid-sdk](docs/research/droid-sdk.md)

## 参考リポジトリ

- [Agent-Reach](https://github.com/Panniantong/Agent-Reach) - url-fetch 設計の元ネタ
