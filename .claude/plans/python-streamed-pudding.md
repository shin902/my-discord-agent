# Context

microsandbox の VM 内で bash ツールを使えるようにする予定であり、現在 `/app`（プロジェクトルート全体）を RW bind mount しているため、bash があるとホスト側のコード・認証情報への書き込み経路が生まれてしまう。

また将来的に Python などのシステムツールを VM 内で使えるようにしたい。

**解決策:** agent-runner を esbuild でバンドルし、必要なシステムツールを含むカスタム Docker イメージを作成。manager.ts のマウントを `/app` 全体から必要最小限に絞る。

---

# 実装計画

## 1. `package.json` — esbuild 追加 + ビルドスクリプト

`devDependencies` に `esbuild` を追加。

`scripts` に以下を追加:
```json
"build:runner": "esbuild src/sandbox/agent-runner.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/sandbox/runner.bundle.mjs",
"runner:image:build": "pnpm build:runner && docker build -t localhost:5050/my-discord-agent-runner:latest . && docker push localhost:5050/my-discord-agent-runner:latest"
```

> `runner:image:build` は必ず `build:runner` を先に実行する（stale bundle でイメージが焼かれるのを防ぐ）。
> スクリプト名は `runner:image:build` とし、ホスト側アプリ全体の Docker build と区別する。

## 2. `Dockerfile` — 新規作成

```dockerfile
FROM node:22-alpine

# bash が本来の目的。python3 は将来のシステムツール用
RUN apk add --no-cache \
    bash \
    python3

WORKDIR /app

# バンドル済み agent-runner を焼き込む（node_modules 不要）
COPY dist/sandbox/runner.bundle.mjs ./runner.mjs
```

## 3. `.dockerignore` — 新規作成

deny-by-default: 全部除外してから必要なものだけ許可する。

```
*
!dist/sandbox/runner.bundle.mjs
```

## 4. `src/agent/manager.ts` — マウント・イメージ・exec の変更

**変更点:**

- `.image("node:22-alpine")` → `.image("localhost:5050/my-discord-agent-runner:latest")`
  - microsandbox は Docker local image store を見ないため、OCI registry 経由で pull できる名前にする
  - local registry（`localhost:5050`）を使う
- `.volume("/app", mb.bind(ROOT))` を削除（/app はイメージに焼き込まれているのでマウント不要）
- セッション・設定用のマウントを追加:
  ```ts
  .volume("/sessions", (mb) => mb.bind(path.join(ROOT, "data/sessions"))) // RW: 既知リスク（bash から会話履歴を直接書き換えられる可能性あり）
  .volume("/config",   (mb) => mb.bind(path.join(ROOT, "config")).readonly())
  ```
- `.env("SESSIONS_DIR", "/app/data/sessions")` → `.env("SESSIONS_DIR", "/sessions")`
- `.env("CREDENTIAL_PROXY_PATH", "/config/credential-proxy.json")` を追加
  - bundle 後は `import.meta.url` の相対パス解決が配置場所依存になるため、環境変数で明示する
- exec を簡素化（`_distExists` チェック不要、バンドルは常にイメージ内に存在）:
  ```ts
  const result = await sandbox.execWith("node", (e) =>
    e
      .args(["/app/runner.mjs"])
      .stdinBytes(Buffer.from(payload))
      .timeout(10 * 60 * 1000),
  );
  ```
- `initManager()` から `dist` ディレクトリ存在チェック（`stat(dist)`）と `_distExists` フラグを削除

## 5. `src/config/credential-proxy.ts` — 環境変数でパス上書き

```ts
// 変更前（import.meta.url からの相対解決）
const configPath = fileURLToPath(new URL("../../config/credential-proxy.json", import.meta.url));

// 変更後（環境変数で明示、なければ従来の相対解決）
const configPath = process.env.CREDENTIAL_PROXY_PATH
  ?? fileURLToPath(new URL("../../config/credential-proxy.json", import.meta.url));
```

`agent-runner.ts` 側の直接参照は不要になる（`manager.ts` の env 経由で渡す）。

---

# マウント構成（変更後）

| マウント先 | ホスト側 | 権限 | 用途 |
|-----------|---------|------|------|
| `/workspace` | `groups/{groupName}/` | RW | エージェント作業領域・AGENTS.md・SKILLS |
| `/sessions` | `data/sessions/` | RW | 会話履歴 JSONL |
| `/config` | `config/` | RO | credential-proxy.json 等 |
| `/app` | （なし） | — | イメージ内に焼き込み済み |

---

# ビルドフロー

```
# agent-runner 変更時（または初回）
pnpm build:runner && pnpm docker:build

# ホスト側のみ変更時（通常の開発）
pnpm build
```

---

# 変更対象ファイル

| ファイル | 操作 |
|---------|------|
| `package.json` | 変更（esbuild 追加・スクリプト追加） |
| `Dockerfile` | 新規作成 |
| `.dockerignore` | 新規作成 |
| `src/agent/manager.ts` | 変更（イメージ・マウント・exec・initManager） |
| `src/config/credential-proxy.ts` | 変更（CREDENTIAL_PROXY_PATH 環境変数対応） |
| `src/agent/manager.test.ts` | 変更（image 名・mount 構成・exec args の検証を更新） |

---

# 検証

```bash
# 1. ビルド・push
pnpm runner:image:build   # build:runner → docker build → docker push まで一括実行

# 2. image の中身確認
docker run --rm localhost:5050/my-discord-agent-runner:latest bash --version
docker run --rm localhost:5050/my-discord-agent-runner:latest python3 --version
docker run --rm localhost:5050/my-discord-agent-runner:latest node -e "require('/app/runner.mjs')" 2>&1

# 3. unit test（mount 構成・image 名・exec args の変更を含む）
pnpm test

# 4. microsandbox smoke test（実際に sandbox を起動して runner が動くか）
pnpm dev
# → Discord でメッセージを送り、応答が返ることを確認
```

**local registry の事前準備:**
```bash
docker run -d -p 5050:5000 --name local-registry registry:2
```
