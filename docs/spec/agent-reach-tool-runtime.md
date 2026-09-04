# agent-reach Tool Runtime

`agent-reach` は Agent sandbox 内で外部コマンドを実行せず、host Tool Proxy から長寿命の専用 Tool Runtime (`compose.tool-runtime.yaml`) へ委譲します。Agent-facing tool name、URL、結果、Markdown境界は従来どおりです。

Runtime の RPC は `POST /rpc` (`{callId,url}`) と、実行中 call を止める `DELETE /rpc/{callId}` だけです。Runtime は結果本文をレスポンスへ返し、Runtime 内のファイルパスを返しません。Agent run ごとに発行される Tool Proxy token と、Skill shell client 専用の `agent-reach` のみを許可する token は別です。

## 起動

`.env` に `AGENT_REACH_RUNTIME_TOKEN` と `AGENT_REACH_REFRESH_TOKEN` を設定し、次を実行します。

```sh
pnpm build:tool-runtime
docker compose -f compose.tool-runtime.yaml up -d --build
```

Runtime は `data/reddit-browser-profile` と `data/reddit-cookies.json` の必要な2領域だけを読み書きマウントします。初回ログインは従来どおり `pnpm reddit:login` を使います。`reddit-cookie-refresh` cron は host scheduler から非公開 maintenance endpoint を呼び、Agent-facing capability には公開しません。

Runtime の outbound firewall は Docker embedded DNS の最小例外を除き loopback、RFC1918、link-local、CGNAT、metadata相当、multicast等を拒否します。アプリケーション側でも全DNS回答とredirect先を検証します。
