# agent-reach Tool Runtime

`agent-reach` は Agent sandbox 内で外部コマンドを実行せず、host Tool Proxy から長寿命の専用 Tool Runtime (`compose.tool-runtime.yaml`) へ委譲します。Agent-facing tool name、URL、結果、Markdown境界は従来どおりです。

Runtime の RPC は `POST /rpc` (`{callId,url}`) と、実行中 call を止める `DELETE /rpc/{callId}` だけです。Runtime は結果本文をレスポンスへ返し、Runtime 内のファイルパスを返しません。Agent run ごとに発行される Tool Proxy token と、Skill shell client 専用の `agent-reach` のみを許可する token は別です。

## 起動

次を実行します。

```sh
pnpm build:tool-runtime
docker compose -f compose.tool-runtime.yaml up -d --build
```

Runtime は `data/reddit-browser-profile` と `data/reddit-cookies.json` の必要な2領域だけを読み書きマウントします。初回ログインは従来どおり `pnpm reddit:login` を使います。`reddit-cookie-refresh` cron は host scheduler から非公開 maintenance endpoint を呼び、Agent-facing capability には公開しません。

Runtime の outbound firewall は Docker embedded DNS の最小例外を除き loopback、RFC1918、link-local、CGNAT、metadata相当、multicast等を拒否します。アプリケーション側でも全DNS回答とredirect先を検証します。

## Trust / network boundary

Agent Runner → Tool Proxy の run-scoped capability authority が認可境界です。Tool Proxy / host → Runtime の HTTP は trusted backend 内部の transport として扱います。host scheduler の maintenance 呼び出しも同じ境界内にあり、Agent-facing capability には登録しません。

Runtime の host publish は `127.0.0.1:8787:8787` に限定します。Runner は Docker の既定 `bridge`、Runtime は Compose の別 bridge network に置き、Docker の bridge 間 isolation を維持します。Runner を Runtime の network や host network へ参加させず、Runtime を Runner の network へ接続しないでください。`host.docker.internal` は host の bridge gateway を指し、host loopback の公開ポートには到達できません。Runtime の URL は host 側の `AGENT_REACH_RUNTIME_URL` で設定でき、Runner へは渡しません。
