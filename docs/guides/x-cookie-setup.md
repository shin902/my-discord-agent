# X検索 Cookieセットアップ

`x-search`は専用Playwright profileから抽出した`auth_token`と`ct0`だけを使用します。普段使いのChrome/Vivaldi profileは読みません。

## 初回ログイン

```sh
pnpm install
pnpm exec playwright install chromium
pnpm x:login
```

開いたX専用ブラウザで手動ログインし、Homeが表示されて「X cookies saved」と端末に出るまで待ってからブラウザを閉じます。`data/x-browser-profile/`とmode `0600`の`data/twitter-cookies.json`が作成されます。値はログへ出ません。

refreshもhost上で実行します。Linux hostにXvfbとChromiumの実行依存を用意してください（例: `sudo apt-get install xvfb` と `pnpm exec playwright install --with-deps chromium`）。loginはGUI表示が必要です。refreshはXvfb上でfull Chromium（`headless: false`）を起動します。必要ならhostの`CHROMIUM_PATH`で実行ファイルを指定できます。Docker / Tool Runtime imageはmaintenanceには不要です。

```sh
pnpm x:refresh
```

loginもstale Cookieの存在だけでは成功とせず、Home到達後にHomeを再読み込みして認証を確認します。起動直後からbrowser closeを監視するため、保存中に閉じても保存完了後に待ち続けません。

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

`x:login` / `x:refresh` / cronはhost-onlyです。refreshはAgent-facing Toolではなく、CLIとcronが同じhost helperを直接呼びます。通常の`x-search`だけがTool Proxy → call-scoped Tool Runtime → `twitter-cli`を使い、`twitter-cookies.json`だけをread-only mountします。専用profileはRuntimeにmountしません。

保存条件はnavigation responseの存在と`ok()`、`https://x.com/home`系URL、ログイン済みSideNavのaccount switcher（`data-testid="SideNav_AccountSwitcher_Button"`）の表示、`auth_token` / `ct0`の両方の取得です。言語依存のラベルではなく、現行X配信の`shared~loader.SideNav~bundle.JobSearch`内で`currentUser`条件とともに確認したtest IDを使います。HTTP 429 / 5xx、login redirect、challenge、認証UI欠落ではthrowし、既存cookie fileを保持します。Cookie値とbrowserの生診断はログへ出しません。

成功時だけmode `0600`のtemp fileへ2値を書き、atomic renameします。cronは失敗をログに出して再throwするため、runnerの`lastRun`は更新されません（cron式の次の試行は既存schedulerのslot規則に従います）。セッション失効時は`pnpm x:login`を再実行してください。同じ専用profileを使うloginとrefreshは同時に実行しないでください。
