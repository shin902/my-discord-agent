# Sandbox 管理ガイド

エージェントは1メッセージごとに使い捨ての Docker コンテナ内で実行される。コンテナが使う Runner イメージとローカルレジストリの管理を `pnpm sandbox` で行う。

## 構成

```
ローカルレジストリ (localhost:5050)
  └─ my-discord-agent-runner:latest   ← Dockerfile + agent-runner.ts のバンドル
       └─ manager.ts が docker run --pull=always で取得・実行する
```

Runner イメージの中身は `src/sandbox/agent-runner.ts` を esbuild でバンドルしたもの（`dist/sandbox/runner.bundle.mjs`）。`agent-runner.ts` を変更したらイメージを再ビルドする必要がある。

## コマンド

```bash
pnpm sandbox build             # 変更後はこれだけでOK（レジストリ未起動なら自動起動）
pnpm sandbox status            # レジストリとイメージの状態を確認
pnpm sandbox logs              # レジストリのログを確認（直近50行）
pnpm sandbox logs -f           # レジストリのログをフォロー表示
pnpm sandbox registry start    # レジストリを起動（初回 or PC 再起動後）
pnpm sandbox registry stop     # レジストリを停止
pnpm sandbox clean             # ローカルのイメージを削除
```

`build` は以下の3ステップをまとめて実行する:

1. `esbuild` で `agent-runner.ts` をバンドル → `dist/sandbox/runner.bundle.mjs`
2. `docker build` でイメージを作成
3. `docker push` でローカルレジストリにプッシュ

## よくある手順

### 初回セットアップ

```bash
pnpm sandbox registry start
pnpm sandbox build
```

### agent-runner.ts を変更した

```bash
pnpm sandbox build
```

### PC を再起動した

レジストリコンテナは `--restart unless-stopped` で起動しているため、Docker Desktop が自動起動していれば再起動後も自動で復帰する。復帰していない場合:

```bash
pnpm sandbox status        # レジストリが「停止中」なら
pnpm sandbox registry start
```

### 状態が不明なとき

```bash
pnpm sandbox status
```

出力例:
```
[sandbox] レジストリ: 起動中 (localhost:5050)
[sandbox] Runner イメージ: あり (2026-05-16)
```

## Network boundary の導入

**arXiv Python Skill / last30days の直接通信を維持して導入するには、それらの移行 PR が先に必要です。** この PR は移行を含まず、下記の機能破壊を伴います。

導入条件を確認してから host と Runner image を一緒に更新してください。新 manager は古い image で起動できません。`pnpm sandbox build` で image を配布してから host を build/restart します。この変更前から動いているコンテナへルールを後付けしないため、再起動時の既存 runner cleanup を経て有効になります。

Linux Docker の namespace 内で IPv4/IPv6 iptables と setpriv が利用でき、host の UID/GID が非 root であることが必要です。rootless Docker や Docker Desktop 等で同じ動作を保証していません。利用環境では以下の統合テストを実行し、失敗時に権限・network 制限を外す fallback は作らないでください。

```bash
pnpm build:runner
docker build -t my-discord-agent-runner:network-test .
SANDBOX_NETWORK_TEST_IMAGE=my-discord-agent-runner:network-test \
  pnpm exec vitest run src/agent/sandbox-network.integration.test.ts
```

CI もこの Docker テストを実行します。通常の `pnpm test` では image 指定がなければ Docker 統合テストを skip します。拒否テストはテスト用 IP に接続できることを先に確認し、firewall 適用後に Node/Python/curl から失敗することを検証します。LLM のストリームと Tool Proxy → Runtime HTTP も検証しますが、CI の外部応答は fixture です。公開ページの実取得を含める場合は、追加で `AGENT_REACH_LIVE_TEST_IMAGE` に既存 Tool Runtime image を指定します（本番 Cookie/token は使いません）。

### direct-egress 閉鎖で壊れる機能と導入順序

| 既存依存 | 閉鎖後の経路 |
|---|---|
| custom / KnownProvider の LLM | Credential Proxy → 設定済み upstream。KnownProvider も接続定義必須 |
| weather / Tavily / arXiv / GitHub / Mail / Calendar | 既存 Tool Proxy capability |
| agent-reach / Reddit Skill | Tool Proxy → 専用 Tool Runtime |
| Bot 内部 RPC | run token 付き既存内部 API。選択した run だけ endpoint を渡す |
| arxiv-search / arxiv-survey Skill の Python | **取得失敗**。公開 Atom API への直接通信が拒否される。既存の native Tool 版は Tool Proxy 経由なので維持 |
| last30days の HN/GitHub 直接 curl | **取得失敗**。Reddit の既存 Tool Proxy 経路は維持 |
| 起動時の r.jina.ai DNS readiness probe | 不要になったため削除 |
| 任意 curl / npm・pip install / remote git・gh 等 | 直接通信不可。local Git・ローカルファイル操作は引き続き可能 |

arXiv / last30days の template・script とコピー済み group Skill はこの PR では変更しません。これらを使用する通常会話・cron を壊さないためには、別 PR で direct-egress 依存を移行してから本変更を導入してください。汎用的な package install / remote Git が必要な用途も、別件で実行経路を決める必要があります。一時的な Skill authority や通信例外は追加しません。

LLM の接続定義がない KnownProvider は sandbox 内で明示エラーとなります。provider SDK が `baseUrl` を使わない独自通信や追加認証を必要とする構成も直接接続できません。既存 Credential Proxy を使う HTTP inference 経路を確認して導入してください。ここで provider-scoped authorization は追加しません。

network / 一時ファイル / 変換処理等を Tool Proxy 配下の generic Tool Runtime に収束させる案は将来の別件です。今回、Runtime の一般化や既存 hardening の削減は行いません。

許可・拒否範囲と残存リスクは [セキュリティ上のトレードオフ](security-tradeoffs.md#agent-sandbox-の-network-boundary) が正本です。

## 内部実装メモ

- スクリプト: `scripts/sandbox.sh`
- レジストリコンテナ名: `my-discord-agent-registry`
- イメージ名: `localhost:5050/my-discord-agent-runner:latest`
- エージェント実行: `src/agent/manager.ts` から Docker CLI の `docker run` を直接起動
- レジストリは insecure（TLS なし）のため、信頼できるローカル環境でのみ使用する

## Tool Runtimeの更新

`pnpm sandbox build` はAgent Runnerと共通 `tool-proxy` CLIを更新します。Tool callごとのRuntime imageは別途 `Dockerfile.tool-runtime` でbuildします。host・両image・配置済みSkillを揃える手順は [Tool Runtimeの導入](spec/tool-runtime.md#導入旧構成からの移行) を参照してください。
