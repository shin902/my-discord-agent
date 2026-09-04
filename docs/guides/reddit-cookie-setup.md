# Reddit クッキー認証 設定手順（agent-reach の reddit サービス）

`agent-reach` ツール（`src/tools/agent-reach.ts`）と互換用スクリプトの Reddit サービスが `www.reddit.com` にアクセスするための設定手順です。取得処理と Cookie は専用の長寿命 Tool Runtime で扱い、Agent sandbox には渡しません。

> [!NOTE]
> 当初は `client_credentials` グラント(OAuth)での実装を検討していたが、2025年11月の Responsible Builder Policy 改定以降、個人が client_id/client_secret を新規取得することが事実上不可能になっている（詳細は [`docs/guides/reddit-oauth-setup.md`](./reddit-oauth-setup.md) 参照）。本ドキュメントは、ログイン済みブラウザのクッキーを使う代替実装の手順。

## 仕組み

```
【初回セットアップ（人間がモニター接続して1回だけ操作）】
  pnpm reddit:login
    → Playwright が headed ブラウザを起動（永続プロファイル: data/reddit-browser-profile/）
    → 表示されたブラウザで捨て垢に手動ログイン
    → ウィンドウを閉じる

【Tool Runtime 起動】
  → `docker compose -f compose.tool-runtime.yaml up -d --build`
  → Runtime は `data/reddit-browser-profile/` と `data/reddit-cookies.json` だけを read/write mount

【定期実行（cron: jobs/reddit-cookie-refresh.ts、デフォルト3日おき）】
  → host の cron scheduler が Runtime の非公開 maintenance operation を呼ぶ
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
- Tool Runtime 用 Docker と、`.env` の `AGENT_REACH_RUNTIME_TOKEN` / `AGENT_REACH_REFRESH_TOKEN`
- Xvfb（Runtime の定期延命処理で使用。Arch Linux なら `sudo pacman -S xorg-server-xvfb`、Debian/Ubuntu なら `sudo apt install xvfb`）

---

## 2. 初回ログイン

```bash
pnpm reddit:login
```

ブラウザが起動するので、画面の指示に従って捨て垢で reddit.com にログインする。ログイン完了後、ブラウザウィンドウを閉じればプロファイル（`data/reddit-browser-profile/`）が保存される。Cookie ファイルが未作成の場合は、同じコマンドが空の初期ファイルを作成します。続けて Tool Runtime を起動してください。

---

## 3. Tool Runtime と cron の設定

`.env` に Runtime 用の短命ではないサービス認証トークンを設定し、Runtime を起動します。Runtime は Reddit 用 state の必要なパスだけを mount します。

```bash
# .env に設定:
# AGENT_REACH_RUNTIME_TOKEN=...
# AGENT_REACH_REFRESH_TOKEN=...
pnpm build:tool-runtime
docker compose -f compose.tool-runtime.yaml up -d --build
```

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

Tool Runtime と host の cron scheduler のログを確認します。Cookie が無い・古い・セッションが失効した場合は、`reddit-cookie-refresh` の既存エラーを出して取得を失敗させます。refresh は Agent-facing capability ではないため、Agent や sandbox から任意に実行できません。

動作確認や再実行は、cron 設定を有効にした host scheduler から行ってください。Runtime が停止している場合は、上記の compose コマンドで再起動します。

---

## 5. 再ログインが必要なケース

- `data/reddit-browser-profile/` を削除した場合
- Reddit側でセッションが無効化された場合（パスワード変更、不審なアクティビティ検知等）
- 長期間ホストまたは Tool Runtime を停止していて、3日おきの延命処理が走らなかった場合

再ログインが必要なときは、`pnpm reddit:login` を再実行する。

---

## 参考リンク

- [rdt-cli](https://github.com/public-clis/rdt-cli) — ブラウザクッキー抽出によるReddit CLIの実装例
- [reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server) — anonymousモードの実装を調査した際の参考
