# セキュリティ上のトレードオフ

意図的に受け入れたセキュリティリスクの記録。

## サンドボックスのプライベートIP egress

**場所:** `src/agent/manager.ts` — `NetworkPolicy.builder().egress(rb => rb.allowPrivate())`

**内容:** サンドボックスコンテナからプライベートIPアドレス（`10.x.x.x`・`192.168.x.x`・`172.16-31.x.x`）への送信を許可している。

**理由:** 同一LAN上の別PCで動作するローカルLLMサーバーへの接続に必要。`allowHost()` はホスト名ベースのルールのため、プライベートIPに解決されるホストへの通信は `allowPrivate()` がないとブロックされる。

**残存リスク:** Agent sandbox 自体の汎用 egress はまだ閉じていない。一方、`agent-reach` の外部取得処理（RSS/feedparser、yt-dlp、curl、Jina など）は sandbox から分離した専用 Tool Runtime で実行し、Runtime 内のアプリケーション検証と outbound firewall の両方で非公開宛先を拒否する。

**対策済み内容:**
- `allowLoopback()` は不要なため削除済み（コンテナ自身への接続を排除）
- agent-reach の両経路で、ループバック・RFC1918・リンクローカル・未指定・CGNAT/Tailscale (`100.64.0.0/10`)・IPv6 ULA/リンクローカル・IPv4-mapped IPv6・文書化用などの IPv6 特殊用途範囲の非公開アドレスを CIDR で拒否
- ホスト名の DNS 解決結果は全件検査し、DNS エラー・空結果・不正な回答はフェイルクローズ
- RSS/feedparser と yt-dlp の子プロセスには DNS ガードを注入し、リダイレクト・追加取得先も解決結果と接続先を検査

## Docker コンテナの無制限ネットワークアクセス

**場所:** `src/agent/manager.ts` — `docker run` の `args`

**内容:** エージェントコンテナは `--network` 制限なしで起動するため、`agent-reach` 以外のコンテナ内処理から任意のホストへの送信が可能。

**理由:** 一般的な Agent sandbox の egress lockdown は今回の対象外とした。`agent-reach` の public Internet 取得は専用 Tool Runtime に移し、Runtime 側では private/loopback/link-local 等を拒否する。

**残存リスク:** Agent sandbox 内で実行される `bash` 等のコードは任意の外部エンドポイントに接続できる。これは今回の移行後も残る既知のリスクで、Agent sandbox 全体の egress lockdown は別作業とする。Tool Runtime 自体は専用 firewall とアプリケーション検証で private/internal destination を拒否する。

**credential proxy との関係:** API キーの漏洩防止はコンテナへ直接キーを渡さない設計（`credential-proxy-server`）で対処済み。ネットワーク制限の欠如とは独立した問題。

## credential proxy の認証なし公開

**場所:** `src/proxy/credential-proxy-server.ts` — `server.listen(0, "0.0.0.0")`

**内容:** プロキシサーバーがエフェメラルポートで全インタフェースにバインドされる。認証機構はなく、ポートさえ分かれば任意のプロセスが API キーを乗せたリクエストを転送できる。

**理由:** Linux では `--add-host=host.docker.internal:host-gateway` がDockerブリッジIP（172.17.0.1）に解決されるため `127.0.0.1` バインドではコンテナから届かない。`0.0.0.0` が必要。

**残存リスク:** ホスト機に到達できる外部プロセスからプロキシポートへのアクセスが可能。エフェメラルポートは推測を困難にするが保証ではない。

**緩和策:** 本番環境ではファイアウォールでプロキシポートへの外部アクセスを遮断すること。
