# セキュリティ上のトレードオフ

意図的に受け入れたセキュリティリスクの記録。

## Agent sandbox のネットワーク境界

**場所:** `src/agent/manager.ts`、`scripts/runner-entrypoint.sh`

Agent sandbox は run ごとの Docker container として起動し、entrypoint が Agent process の開始前に outbound firewall を設定する。許可するのは `host.docker.internal` のうち、host manager がその run に必要と判断した TCP port だけである。

- Credential Proxy port: LLM inference と、選択時の Bot internal RPC
- Tool Proxy port: host capability または `agent-reach` Skill が選択された run だけ

それ以外の public Internet、localhost、RFC1918 / LAN、Tailscale / CGNAT、link-local / metadata、Docker network peer、host の別 port、DNS は IPv4 / IPv6 とも default deny になる。`curl`、Python、Node、Git 等の program 種別には依存しない。

Container entrypointにだけfirewall設定用の`CAP_NET_ADMIN`、non-root identityへ移行するための`CAP_SETUID` / `CAP_SETGID`、bounding setを消去するための`CAP_SETPCAP`を与える。entrypointは設定後にnon-root UID/GIDへ移行し、capability bounding setをすべてdropしてからAgent runnerを起動するため、Agent processはpolicyを変更できない。`no-new-privileges`もcontainer起動時から有効にする。

LLMのmodel providerはsandbox内でCredential Proxy URLへ向ける。KnownProviderはpi-aiのAPI・model metadataを維持して`baseUrl`だけを置換し、明示的なcustom providerは従来のcustom解決を維持するため、built-in providerのpublic endpointへ迂回しない。Sandboxからのprovider requestにはrun-scoped tokenを付与し、そのrunで選択したprovider以外のcredential routeをCredential Proxy側で拒否する。従ってmodel providerには有効な`config/credentials.json` entryが必要である。Agent runnerが以前行っていた`r.jina.ai`のDNS readiness probeは、public DNSを許可しない現在の境界では不要なため削除した。

`agent-reach` の外部取得はこの sandbox 内では実行しない。通信経路は `Agent sandbox → Tool Proxy → agent-reach Tool Runtime → public Internet` であり、Tool Runtime の既存 firewall と application-level destination validation は維持する。

### 検証

`pnpm runner:network:smoke` は実 Docker container と到達可能な canary を使い、policy 無効時には到達できることを positive control とした上で、次を確認する。

- Credential Proxy / Tool Proxy 相当の明示 portだけへ到達できる
- 同じ host gateway の別 portへ到達できない
- public-looking destination、RFC1918、link-local、metadata endpoint、localhostへ到達できない

CI でもこの smoke test を実行する。

### 残存リスク

- 許可された Tool Proxy capability や LLM prompt 自体が情報流出経路になり得る。network isolation は run-scoped capability、schema validation、approval、機密情報を sandbox に渡さない設計の代替ではない。
- Firewall は通常Agentの誤判断・prompt injectionを封じ込める境界であり、kernel / Docker daemon exploit後の完全な封じ込めを保証しない。
- Credential Proxy と Tool Proxy は host 上で `0.0.0.0` に bindする。Agent sandbox からは許可port以外へ到達できないが、host外からの到達性は deployment firewall に依存する。
- operator が設定する extra mount は trusted configuration であり、高権限socket/pathの一般blacklistはまだ持たない。

## agent-reach Tool Runtime

Agent sandboxとは別の長寿命containerである。外部URL取得のため public Internet は許可する一方、Runtime firewallとapplication-level検証でloopback、RFC1918、link-local、CGNAT/Tailscale、metadata等を拒否する。DNS解決結果、redirect、RSS/feedparser、yt-dlp等の子process経路も検証対象である。

このRuntimeのpublic egress、認証、credential / scratch lifecycleはAgent sandboxのdeny-by-default化によって削除・緩和しない。

## Credential Proxy の host bind

**場所:** `src/proxy/credential-proxy-server.ts` — `server.listen(0, "0.0.0.0")`

Linux containerからDocker bridge gateway経由で接続するため、Credential Proxyはephemeral portを全interfaceへbindする。Non-loopbackのprovider forwardingはrun-scoped tokenを要求し、選択されたmodel providerだけを許可する。Host内部の既存cron等はloopback接続を使う。

Agent sandbox側ではdestination port allowlistにより同じhostの別serviceへ到達できず、model requestはCredential Proxyへ固定される。ただし選択したLLM provider内のpathをinference APIだけへ限定する専用gatewayではない。またloopback上のhost processはtrusted control planeとしてtokenなしでprovider routeを利用できる。本番環境ではhost firewallでもproxy portへの外部アクセスを遮断する。
