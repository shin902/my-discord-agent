# X検索 Cookieセットアップ

`x-search`は専用Playwright profileから抽出した`auth_token`と`ct0`だけを使用します。普段使いのChrome/Vivaldi profileは読みません。

## 初回ログイン

```sh
pnpm install
pnpm exec playwright install chromium
pnpm x:login
```

開いたX専用ブラウザで手動ログインし、Homeが表示されて「X cookies saved」と端末に出るまで待ってからブラウザを閉じます。`data/x-browser-profile/`とmode `0600`の`data/twitter-cookies.json`が作成されます。値はログへ出ません。

Tool Runtime imageをbuildして、maintenance経路を確認します。

```sh
pnpm build:tool-runtime
docker build -f Dockerfile.tool-runtime -t my-discord-agent-tool-runtime:latest .
pnpm x:refresh
```

## 定期refresh

`config/cron.example.json`の無効な例を必要な環境の`config/cron.json`へ追加し、有効化してhostを再起動します。既定例は3日おきです。

```json
{
  "id": "x-cookie-refresh",
  "schedule": "30 4 */3 * *",
  "enabled": true,
  "handler": "jobs/x-cookie-refresh.ts"
}
```

refreshはAgent-facing Toolではありません。hostの`pnpm x:refresh`またはcronだけが単発Tool Runtimeを起動します。maintenance時だけ専用profileと隔離された出力ディレクトリをread/write mountし、hostが成功後に`twitter-cookies.json`をatomic renameします。通常の`x-search`はcookie fileだけをread-only mountし、profileを参照しません。

失敗時は既存cookie fileを保持します。セッション失効時は`pnpm x:login`を再実行してください。
