# Sandbox 管理ガイド

エージェントは microsandbox の microVM 内で実行される。VM が使うコンテナイメージ（Runner イメージ）とローカルレジストリの管理を `pnpm sandbox` で行う。

## 構成

```
ローカルレジストリ (localhost:5050)
  └─ my-discord-agent-runner:latest   ← Dockerfile + agent-runner.ts のバンドル
       └─ microsandbox が VM 起動時に pull して使う
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

## 内部実装メモ

- スクリプト: `scripts/sandbox.sh`
- レジストリコンテナ名: `my-discord-agent-registry`
- イメージ名: `localhost:5050/my-discord-agent-runner:latest`
- レジストリは insecure（TLS なし）。microsandbox 側も `.insecure()` で対応済み（`src/agent/manager.ts`）
