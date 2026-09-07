# セキュリティ上のトレードオフ

意図的に受け入れたセキュリティリスクと、現在のsandbox境界を記録する。

## Agent Runnerのネットワーク境界

**場所:** `src/agent/manager.ts`、`scripts/runner-entrypoint.sh`

Agent Runnerはrunごとの使い捨てDockerコンテナとして起動し、entrypointがNode/Agentを起動する前にnamespace内のIPv4/IPv6 `OUTPUT` をdeny-by-defaultへ設定する。AgentプロセスはホストUID/GIDのnon-rootへ降格し、`CAP_NET_ADMIN`・UID/GID変更権限・`CAP_SETPCAP`をsetup後にbounding/inheritable/ambient/effective setsから除去する。`no-new-privileges`もDocker起動時に有効化する。

新規接続で許可されるのは、Dockerの `host.docker.internal` が解決される**その1つのhost-gateway IPv4**へのTCP接続のうち、managerがrunごとに渡したポートだけである。

- Credential Proxyポート: 現行LLM経路とBot internal RPC用
- Tool Proxyポート: run tokenまたはSkill用のsemantic capability authorityが存在する場合だけ
- それ以外のhost port、localhost/loopback、RFC1918/LAN、CGNAT/Tailscale、link-local/metadata、任意public Internet、IPv6新規接続: deny

ポート許可はsemantic authorizationの代替ではない。Credential Proxyは現行LLM移行のための暫定共有ポートで、ポートへ到達できてもprovider/pathの認証やTool Proxyのrun-scoped capability検証を飛び越せない境界ではない。長期的にはLLM Gatewayへ移行し、generic credential forwardingとBot RPCを分離する。

## agent-reach Tool Runtimeのpublic egress

Agent Runnerからpublic Internetへ直接接続するのではなく、Agent Reachは `Runner → Tool Proxy → Tool Runtime` へ移行している。Tool Runtimeはpublic Internetを許可する一方、RFC1918、link-local、CGNAT、metadata相当、multicast等を拒否する。Runnerのdeny-by-defaultとRuntimeのpublic-only firewallは別の境界であり、Runtimeの例外をRunnerへ戻さない。

## Credential Proxyの認証なし公開

**場所:** `src/proxy/credential-proxy-server.ts` — `server.listen(0, "0.0.0.0")`

Credential ProxyはDocker bridgeから届く必要があるため、エフェメラルポートで全インタフェースにバインドされる。Runner側のネットワーク許可はhost-gatewayのmanager指定ポートだけだが、Credential Proxy自体はTool Proxyのrun-scoped capability認可と同じ保証を持たず、同じポート上のprovider/path forwardingも暫定的に残る。

**残存リスク:** ホスト機に到達できる外部プロセスからプロキシポートへアクセスでき、ポート番号だけでは認証境界にならない。外部からの到達はホストファイアウォールで遮断し、LLM Gateway移行後にCredential forwardingを退役させる。
