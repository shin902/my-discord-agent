# my-discord-agent

Discord上で動作するAIエージェントボット。

## 概要

my-nanoclawプロジェクトの失敗を教訓に、"確実に動く"ことを保証しながら実装を進めています。E2Eテストを含めた堅実な開発アプローチを取っています。

## 主な機能

- Discordスレッドごとのチャット対応
- URL共有時の自動スレッド作成・応答
- サンドボックス実行環境（予定）
- クレデンシャルプロキシ（予定）

## 技術スタック

- **Agent SDK**: pi-agent-core
- **Model Provider**: OpenCode Go
- **Platform**: Discord

## ドキュメント

- [Research & Requirements](docs/research/README.md) - 技術調査・要件定義・選定理由
    - [pi-agent-core](docs/research/pi/core/pi-agent-core.md)
    - [pi-ai](docs/research/pi/ai/pi-ai.md)
    - [droid-sdk](docs/research/droid-sdk.md)
