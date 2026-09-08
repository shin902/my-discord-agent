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

hostとRunner imageを一緒に更新してください。新managerは古いimageで起動できません。`pnpm sandbox build`でimageを配布してからhostをbuild/restartします。この変更前から動いているコンテナへルールを後付けしないため、再起動時の既存runner cleanupを経て有効になります。

arXiv・last30daysを含む組込SkillはTool Proxy / 使い捨てRuntimeへ移行済みです。以前コピーしたgroup Skillは自動更新されないため、[Tool Runtimeの移行手順](spec/tool-runtime.md#配置済みskillの更新)に従って配置済みSkillと両imageを揃えてください。

Linux Dockerのnamespace内でIPv4/IPv6 iptablesとsetprivが利用でき、hostのUID/GIDが非rootであることが必要です。rootless DockerやDocker Desktop等で同じ動作を保証していません。利用環境では以下の統合テストを実行し、失敗時に権限・network制限を外すfallbackは作らないでください。

```bash
pnpm build:runner
docker build -t my-discord-agent-runner:network-test .
docker build -f Dockerfile.tool-runtime -t my-discord-agent-tool-runtime:network-test .
DOTENV_CONFIG_PATH=/dev/null \
  SANDBOX_NETWORK_TEST_IMAGE=my-discord-agent-runner:network-test \
  TOOL_RUNTIME_TEST_IMAGE=my-discord-agent-tool-runtime:network-test \
  pnpm exec vitest run src/agent/sandbox-network.integration.test.ts src/runtime/tool-runtime.integration.test.ts src/runtime/tool-runtime-agent.integration.test.ts
```

CIも両imageを一度ずつbuildし、このDocker検証を含む全testを実行します。imageを指定しない通常testではDocker統合testをskipします。拒否testはテスト用IPに接続できることを先に確認し、firewall適用後にNode/Python/curlから失敗することを検証します。実Agent loopのLLMストリーム、Tool Proxy → 使い捨てRuntime、各Skill CLI、成果物のrun内寿命も確認します。公開APIの応答とReddit stateにはfixtureだけを使います。

### direct-egress 閉鎖後の実行経路

| 機能 | 実行経路 |
|---|---|
| custom / KnownProviderのLLM | Credential Proxy → 設定済みupstream。KnownProviderも接続定義必須 |
| weather / Tavily / 既存GitHub Tool / Mail / Calendar | Tool Proxy → host executor |
| agent-reach / arXiv Tool・Skill / last30days | 共通run tokenでTool Proxy → Tool callごとの使い捨てRuntime |
| Bot内部RPC | run token付き既存内部API。利用するrunだけendpointを渡す |
| 任意curl / npm・pip install / remote git・gh等 | 直接通信不可。local Git・ローカルファイル操作は引き続き可能 |

Skill単独利用も組込依存から共通authorityを得ます。native Toolを追加するためだけの設定変更は不要です。設定したapprovalはnative/CLI双方に適用します。汎用的なpackage install / remote Git用の通信例外は提供しません。

LLMの接続定義がないKnownProviderはsandbox内で明示エラーになります。provider SDKが`baseUrl`を使わない独自通信や追加認証を必要とする構成も直接接続できません。既存Credential Proxyを使うHTTP inference経路を確認して導入してください。provider単位の認可は追加しません。起動時の外部DNS readiness probeは不要になったため削除しています。

許可・拒否範囲と残存リスクは[セキュリティ上のトレードオフ](security-tradeoffs.md#agent-sandbox-の-network-boundary)を参照してください。

## 内部実装メモ

- スクリプト: `scripts/sandbox.sh`
- レジストリコンテナ名: `my-discord-agent-registry`
- イメージ名: `localhost:5050/my-discord-agent-runner:latest`
- エージェント実行: `src/agent/manager.ts` から Docker CLI の `docker run` を直接起動
- レジストリは insecure（TLS なし）のため、信頼できるローカル環境でのみ使用する

## Tool Runtimeの更新

`pnpm sandbox build` はAgent Runnerと共通 `tool-proxy` CLIを更新します。Tool callごとのRuntime imageは別途 `Dockerfile.tool-runtime` でbuildします。host・両image・配置済みSkillを揃える手順は [Tool Runtimeの導入](spec/tool-runtime.md#導入旧構成からの移行) を参照してください。
