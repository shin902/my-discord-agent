# セキュリティ上のトレードオフ

意図的に受け入れたセキュリティリスクの記録。

## Agent sandbox の network boundary

主目的は、prompt injection や Agent の誤判断で任意プログラムを実行しても、許可された接続先以外へ直接通信できないことです。manager が起動する run 単位の Docker container に適用します。

[`sandbox-network.ts`](../src/agent/sandbox-network.ts) が Docker bridge、固定 host-gateway、必要な host TCP port と image 内の [`sandbox-entrypoint.sh`](../scripts/sandbox-entrypoint.sh) を指定します。entrypoint は IPv4/IPv6 OUTPUT を deny-by-default にし、host-gateway の Credential Proxy port と、run が利用する Tool Proxy / Bot 内部 API port だけを許可します。公開 Internet、任意 host port、localhost、RFC1918、CGNAT/Tailscale、link-local/metadata、他 Docker service は拒否します。IPv6 は全拒否、DNS/UDP に例外はなく、host 名は Docker が生成する `/etc/hosts` で解決します。

firewall 設定中だけ root と NET_ADMIN / SETUID / SETGID / SETPCAP を使い、Agent・workspace・stdin を処理する前に host UID/GID（非 root）、空の capability bounding set、no_new_privs へ移ります。Agent はルール変更・raw packet 送信に必要な権限を持ちません。設定失敗・未対応 IPv6 firewall・古い image による entrypoint 不在は起動失敗となり、無制限通信への fallback はありません。ルールは container の network namespace 内だけに存在し、破棄時に消えます。運用条件と移行は [Sandbox 管理ガイド](sandbox-command.md#network-boundary-の導入) を参照してください。

LLM は Credential Proxy 経由で host が設定済み upstream へ接続します。Tool Proxy は既存の run token / capability / approval を強制し、`agent-reach`・arXiv・last30daysはTool callごとの使い捨てRuntimeへ委譲します。RuntimeにHTTP入口やservice/maintenance tokenはなく、Agentから直接接続する経路はありません。Tool Runtimeの既存firewall、DNS/redirect検証、subprocess guard、Cookie境界は維持します。

### 効果の限界

- 許可された LLM / 検索 / URL 取得等を使った情報持ち出しは network isolation だけでは防げません。
- Credential Proxy は secret confidentiality と credential injection / forwarding を担当し、authorization plane ではありません。Agent が inference credential を利用すること自体は許可し、他の inference provider を選ぶ可能性も受け入れます。provider/model/path/method 認可、inference run token、approval、独自 rate limit は追加しません。利用自体を制限すべき credential-backed operation が残る場合は、Credential Proxy を拡張せず Tool Proxy capability へ移します。
- host、Docker daemon、image、operator-only mounts は trust root です。危険な socket や bootstrap を置換する mount を trusted config で許せば境界を壊せます。mount policy 全面変更は行っていません。
- container/kernel escape や parser/Chromium の侵害後の完全封じ込めは保証しません。seccomp 大規模変更、AppArmor/SELinux、Landlock、追加 sandbox、mTLS は導入していません。

Tool Runtimeへ移行済みの機能と、直接通信できなくなる任意コマンドの扱いは[導入ガイド](sandbox-command.md#direct-egress-閉鎖後の実行経路)を参照してください。

## credential proxy の認証なし公開

**場所:** `src/proxy/credential-proxy-server.ts` — `server.listen(0, "0.0.0.0")`

**内容:** プロキシサーバーがエフェメラルポートで全インタフェースにバインドされる。認証機構はなく、ポートさえ分かれば任意のプロセスが API キーを乗せたリクエストを転送できる。

**理由:** Linux では `--add-host=host.docker.internal:host-gateway` がDockerブリッジIP（172.17.0.1）に解決されるため `127.0.0.1` バインドではコンテナから届かない。`0.0.0.0` が必要。

**残存リスク:** ホスト機に到達できる外部プロセスからプロキシポートへのアクセスが可能。エフェメラルポートは推測を困難にするが保証ではない。

**緩和策:** 本番環境ではファイアウォールでプロキシポートへの外部アクセスを遮断すること。
