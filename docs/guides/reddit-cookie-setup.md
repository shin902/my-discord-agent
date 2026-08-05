# Reddit クッキー認証 設定手順（agent-reach の reddit サービス）

`agent-reach` ツール（`src/tools/agent-reach.ts`）と互換用スクリプトのredditサービスが`www.reddit.com`にアクセスするための設定手順です。

> [!NOTE]
> 当初は `client_credentials` グラント(OAuth)での実装を検討していたが、2025年11月の Responsible Builder Policy 改定以降、個人が client_id/client_secret を新規取得することが事実上不可能になっている（詳細は [`docs/guides/reddit-oauth-setup.md`](./reddit-oauth-setup.md) 参照）。本ドキュメントは、ログイン済みブラウザのクッキーを使う代替実装の手順。

## 仕組み

```
【初回セットアップ（人間がモニター接続して1回だけ操作）】
  pnpm reddit:login
    → Playwright が headed ブラウザを起動（永続プロファイル: data/reddit-browser-profile/）
    → 表示されたブラウザで捨て垢に手動ログイン
    → ウィンドウを閉じる

【定期実行（cron: jobs/reddit-cookie-refresh.ts、デフォルト3日おき）】
  → 同じプロファイルを Xvfb 上で headless:false 起動（フルChromium、ヘッドレス専用バイナリは使わない）
  → www.reddit.com を開いてセッションを延命 + クッキーを再抽出
  → data/reddit-cookies.json に保存（0600）

【リクエスト時】
  agent-reach (reddit case) → credential-proxy が data/reddit-cookies.json から
  Cookie ヘッダーを構築して www.reddit.com/*.json に注入
```

ヘッドレスChromium(`chrome-headless-shell`)は Reddit の bot 対策（PerimeterX/Akamai系の JS チャレンジ）に検知されてブロックされるが、Xvfb 上でフルChromiumを `headless: false` で起動すると通過することを実機検証で確認している。一方 curl 等の非ブラウザクライアントは、有効なログイン済みクッキーがあれば JS チャレンジを経由せず `.json` エンドポイントに直接アクセスできる（クッキー抽出時のみブラウザエンジンが必要で、実際のデータ取得は軽量な curl で済む）。

> [!WARNING]
> 個人アカウントを自動化アクセスに使うことは Reddit の利用規約上グレーゾーンであり、アカウント停止のリスクがある。**捨て垢を使うこと**を強く推奨する。

---

## 1. 前提

- ホストマシンに **モニターを接続できること**（初回ログインのみ。X11フォワーディングやVNCでも代用可）
- `pnpm install` 後、Playwright のブラウザ本体をインストール: `npx playwright install chromium`
- Xvfb（定期延命処理で使用。Arch Linux なら `sudo pacman -S xorg-server-xvfb`、Debian/Ubuntu なら `sudo apt install xvfb`）

---

## 2. 初回ログイン

```bash
pnpm reddit:login
```

ブラウザが起動するので、画面の指示に従って捨て垢で reddit.com にログインする。ログイン完了後、ブラウザウィンドウを閉じればプロファイル(`data/reddit-browser-profile/`)が保存される。

---

## 3. `config/credentials.json` への設定

`config/credentials.json` の配列に追加（`credentials.example.json` も参照）:

```json
{
  "provider": "reddit",
  "baseUrl": "https://www.reddit.com",
  "redditCookie": {
    "cookieFile": "data/reddit-cookies.json",
    "maxAgeDays": 7
  }
}
```

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

ホスト起動時、以下のようなログが出ていれば成功:

```
[credential-proxy] Reddit cookie OK for provider: reddit
```

失敗時:

```
[credential-proxy] reddit cookie ファイルが見つかりません ... → 手順2の初回ログインが未実施
[credential-proxy] reddit cookie が期限切れです ... → reddit-cookie-refresh ジョブが実行されていない（cron設定・ホストの起動状態を確認）
```

cronジョブを手動実行して確認したい場合は、`src/proxy/reddit-cookie-refresh.ts` の `refreshRedditCookies()` を直接呼ぶ小さなスクリプトを書くか、ホストプロセスを再起動して該当時刻まで待つ。

---

## 5. 再ログインが必要なケース

- `data/reddit-browser-profile/` を削除した場合
- Reddit側でセッションが無効化された場合（パスワード変更、不審なアクティビティ検知等）
- 長期間ホストを停止していて、3日おきの延命処理が走らなかった場合

再ログインが必要なときは、`pnpm reddit:login` を再実行する。

---

## 参考リンク

- [rdt-cli](https://github.com/public-clis/rdt-cli) — ブラウザクッキー抽出によるReddit CLIの実装例
- [reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server) — anonymousモードの実装を調査した際の参考
