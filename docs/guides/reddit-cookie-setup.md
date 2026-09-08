# Reddit クッキー認証 設定手順（agent-reach の reddit サービス）

Agent-facing `agent-reach` capability（`src/tools/runtime-capabilities.ts`）と互換用スクリプトの Reddit サービスが `www.reddit.com` にアクセスするための設定手順です。取得処理と Cookie はTool callごとの使い捨て Tool Runtime で扱い、Agent sandbox には渡しません。

> [!NOTE]
> 当初は `client_credentials` グラント(OAuth)での実装を検討していたが、2025年11月の Responsible Builder Policy 改定以降、個人が client_id/client_secret を新規取得することが事実上不可能になっている（詳細は [`docs/guides/reddit-oauth-setup.md`](./reddit-oauth-setup.md) 参照）。本ドキュメントは、ログイン済みブラウザのクッキーを使う代替実装の手順。

## 仕組み

```
【初回セットアップ（人間がモニター接続して1回だけ操作）】
  pnpm reddit:login
    → Playwright が headed ブラウザを起動（永続プロファイル: data/reddit-browser-profile/）
    → 表示されたブラウザで捨て垢に手動ログイン
    → ウィンドウを閉じる

【Tool Runtime image準備と初回 refresh】
  → `docker build -f Dockerfile.tool-runtime -t my-discord-agent-tool-runtime:latest .`
  → maintenance containerだけがprofileとCookieをread/write mount
  → ホストで `pnpm reddit:refresh` を1回実行して Cookie を直ちに作成・確認

【定期実行（cron: jobs/reddit-cookie-refresh.ts、デフォルト3日おき）】
  → host の cron scheduler が単発maintenance containerを起動する
  → Runtime が同じプロファイルを Xvfb 上で headless:false 起動（フルChromium）
  → www.reddit.com を開いてセッションを延命し、Cookie を `data/reddit-cookies.json` に 0600 で保存

【リクエスト時】
  agent-reach → Tool Proxy → Tool Runtime が Cookie を読み、www.reddit.com/*.json を取得
  （Cookie と Runtime 内のファイルパスは Agent sandbox に返さない）
```

ヘッドレスChromium(`chrome-headless-shell`)は Reddit の bot 対策（PerimeterX/Akamai系の JS チャレンジ）に検知されてブロックされるが、Xvfb 上でフルChromiumを `headless: false` で起動すると通過することを実機検証で確認している。一方、Runtime 内の非ブラウザ取得処理は、有効なログイン済み Cookie があれば JS チャレンジを経由せず `.json` エンドポイントに直接アクセスできる（Cookie 抽出時のみブラウザエンジンが必要）。

> [!WARNING]
> 個人アカウントを自動化アクセスに使うことは Reddit の利用規約上グレーゾーンであり、アカウント停止のリスクがある。**捨て垢を使うこと**を強く推奨する。

---

## 1. 前提

- ホストマシンに **モニターを接続できること**（初回ログインのみ。X11フォワーディングやVNCでも代用可）
- `pnpm install` 後、Playwright のブラウザ本体をインストール: `npx playwright install chromium`
- Dockerと事前buildしたTool Runtime image。既定名は `my-discord-agent-tool-runtime:latest`、hostの `TOOL_RUNTIME_IMAGE` で変更可能

---

## 2. 初回ログイン

```bash
pnpm reddit:login
```

ブラウザが起動するので、画面の指示に従って捨て垢で reddit.com にログインする。ログイン完了後、ブラウザウィンドウを閉じればプロファイル（`data/reddit-browser-profile/`）が保存される。Cookie ファイルが未作成の場合は、同じコマンドが空の初期ファイルを作成します。続けてTool Runtime imageを準備し、ホストで次のone-shot refreshを実行してください。

```bash
docker build -f Dockerfile.tool-runtime -t my-discord-agent-tool-runtime:latest .
pnpm reddit:refresh
```

`pnpm reddit:refresh` はホストからmaintenance containerを1回起動する運用コマンドです。HTTP endpointやmaintenance tokenは使いません。Agent-facing capabilityやsandboxへmaintenanceを公開しません。

---

## 3. Tool Runtime と cron の設定

常駐serviceや専用認証tokenは不要です。通常のReddit取得はCookieをread-only mountし、maintenanceだけがprofileとCookieをread/write mountします。既存のstateはcontainer破棄後も保持します。hostが非root所有者を検証し、RuntimeをそのUID/GIDで実行します。profileとCookieは同じ所有者にしてください。

旧構成の停止・廃止env・image更新は [Tool Runtime移行手順](../spec/tool-runtime.md#導入旧構成からの移行) を参照してください。

Reddit の Cookie を `config/credentials.json` に追加したり、Credential Proxy 用の `reddit` provider を設定したりする必要はありません。

`config/cron.json` に定期延命ジョブを追加（デフォルトで3日おき。スケジュールは crontab 形式）:

```json
{
  "id": "reddit-cookie-refresh",
  "schedule": "0 4 */3 * *",
  "enabled": true,
  "handler": "jobs/reddit-cookie-refresh.ts"
}
```

---

## 4. 動作確認

`pnpm reddit:refresh` が成功し、`data/reddit-cookies.json` が作成・更新されたことを確認します。その後、hostの運用コマンドとcron schedulerの結果を確認します。Cookie が無い・古い・セッションが失効した場合は、`reddit-cookie-refresh` の既存エラーを出して取得を失敗させます。refresh は Agent-facing capability ではないため、Agent や sandbox から任意に実行できません。

再ログイン後の再実行も、ホストで `pnpm reddit:refresh` を実行してください。定期的な延命はcron設定を有効にした host scheduler が行います。imageが無い場合は上記のbuildコマンドで準備します。常駐Runtimeの再起動は不要です。

---

## 5. 再ログインが必要なケース

- `data/reddit-browser-profile/` を削除した場合
- Reddit側でセッションが無効化された場合（パスワード変更、不審なアクティビティ検知等）
- 長期間host schedulerが停止していて、3日おきの延命処理が走らなかった場合

再ログインが必要なときは、`pnpm reddit:login` を再実行する。

---

## 参考リンク

- [rdt-cli](https://github.com/public-clis/rdt-cli) — ブラウザクッキー抽出によるReddit CLIの実装例
- [reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server) — anonymousモードの実装を調査した際の参考
