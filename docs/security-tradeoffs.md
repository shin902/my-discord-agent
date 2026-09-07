# セキュリティ上のトレードオフ

意図的に受け入れたセキュリティリスクの記録。

## Agent sandbox の network boundary

主目的は、prompt injection や Agent の誤判断で任意プログラムを実行しても、許可された接続先以外へ直接通信できないことです。manager が起動する run 単位の Docker container に適用します。

[`sandbox-network.ts`](../src/agent/sandbox-network.ts) が Docker bridge、固定 host-gateway、必要な host TCP port と image 内の [`sandbox-entrypoint.sh`](../scripts/sandbox-entrypoint.sh) を指定します。entrypoint は IPv4/IPv6 OUTPUT を deny-by-default にし、host-gateway の Credential Proxy port と、run が利用する Tool Proxy / Bot 内部 API port だけを許可します。公開 Internet、任意 host port、localhost、RFC1918、CGNAT/Tailscale、link-local/metadata、他 Docker service は拒否します。IPv6 は全拒否、DNS/UDP に例外はなく、host 名は Docker が生成する `/etc/hosts` で解決します。

firewall 設定中だけ root と NET_ADMIN / SETUID / SETGID / SETPCAP を使い、Agent・workspace・stdin を処理する前に host UID/GID（非 root）、空の capability bounding set、no_new_privs へ移ります。Agent はルール変更・raw packet 送信に必要な権限を持ちません。設定失敗・未対応 IPv6 firewall・古い image による entrypoint 不在は起動失敗となり、無制限通信への fallback はありません。ルールは container の network namespace 内だけに存在し、破棄時に消えます。運用条件と移行は [Sandbox 管理ガイド](sandbox-command.md#network-boundary-の導入) を参照してください。

LLM は Credential Proxy 経由で host が設定済み upstream へ接続します。Tool Proxy は既存の run token / capability / approval を強制し、`agent-reach` は引き続き専用 Tool Runtime へ委譲します。Tool Runtime の既存 firewall、DNS/redirect 検証、subprocess guard、service/maintenance token、Cookie 境界は変更していません。

### 効果の限界

- 許可された LLM / 検索 / URL 取得等を使った情報持ち出しは network isolation だけでは防げません。
- Credential Proxy の既存 forwarding は **run ごとの provider/path 認可を持ちません**。その許可 port にある他 provider route も呼べるため、Tool Proxy の capability 制限と同じ保証ではありません。URL を sandbox の設定から除くことは認可ではなく、この残存経路の整理は別作業です。
- host、Docker daemon、image、operator-only mounts は trust root です。危険な socket や bootstrap を置換する mount を trusted config で許せば境界を壊せます。mount policy 全面変更は行っていません。
- container/kernel escape や parser/Chromium の侵害後の完全封じ込めは保証しません。seccomp 大規模変更、AppArmor/SELinux、Landlock、追加 sandbox、mTLS は導入していません。

### Tool Runtime の将来の簡素化候補（提案のみ）

URL/DNS 検証と Python subprocess guard に重複する宛先分類は、parser ごとの必要性と redirect/rebinding テストを揃えてから共通化の費用対効果を検討できます。また、現行 Runtime firewall の loopback 全許可と Docker DNS 例外は別途見直し候補です。Agent sandbox の閉鎖だけを根拠に既存 guard や認証を削除しません。

## credential proxy の認証なし公開

**場所:** `src/proxy/credential-proxy-server.ts` — `server.listen(0, "0.0.0.0")`

**内容:** プロキシサーバーがエフェメラルポートで全インタフェースにバインドされる。認証機構はなく、ポートさえ分かれば任意のプロセスが API キーを乗せたリクエストを転送できる。

**理由:** Linux では `--add-host=host.docker.internal:host-gateway` がDockerブリッジIP（172.17.0.1）に解決されるため `127.0.0.1` バインドではコンテナから届かない。`0.0.0.0` が必要。

**残存リスク:** ホスト機に到達できる外部プロセスからプロキシポートへのアクセスが可能。エフェメラルポートは推測を困難にするが保証ではない。

**緩和策:** 本番環境ではファイアウォールでプロキシポートへの外部アクセスを遮断すること。
