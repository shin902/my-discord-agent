# RSSフィード形式の対応範囲調査

RSS収集機能を汎用フィードリーダーとして肥大化させず、`my-discord-agent`で実際に必要な形式だけを保守するための調査記録。

## 結論

このプロジェクトの標準対応範囲は、次の2形式に絞る。

- RSS 2.0
- Atom 1.0

RSS 1.0 / RDFは世界的な主要サービスではレガシー寄りだが、日本のニュース系サービスでは現在も使われている。したがって「常に維持する形式」ではなく、はてなブックマーク、朝日新聞、Impress Watchなどを購読すると決まった時点で追加するオプション互換とする。

次の形式は対応対象外とする。

- RSS 0.90
- RSS 0.91
- RSS 0.92
- RSS 0.93
- RSS 0.94
- Atom 0.3
- JSON Feed 1.0 / 1.1
- UTF-8以外の文字コード

現在設定されている購読先はRSS 2.0とAtom 1.0だけで処理できる。

## 判断基準

次の2つのペルソナを比較した。

### 個人用フィード収集器

- 購読先を設定ファイルで明示する
- 不特定多数のフィードを受け付けない
- 対応範囲より、コードと依存関係の小ささを優先する
- 新しい形式は実際の購読先で必要になってから追加する

### 汎用フィードリーダー

- ユーザーが任意のURLを登録する
- 古いCMSや国内ニュースサイトも可能な限り処理する
- RSS 1.0 / RDFや非UTF-8を含む後方互換性を優先する

`my-discord-agent`は前者である。KISSとYAGNIの観点から、汎用フィードリーダー相当の互換性は持たせない。

## 公開フィードの実測

2026-07-29に、国内外のCMS、ニュース、開発、動画、ニュースレター系サービスから20件を選び、実際のレスポンス本文のルート要素とXML宣言を確認した。

これは無作為抽出による市場占有率調査ではない。現在の代表的な配信元で、各形式を削除した場合にどのような実害があるかを確認するための意図的なサンプルである。

### 集計

| 形式 | 件数 | 割合 |
|---|---:|---:|
| RSS 2.0 | 9 | 45% |
| Atom 1.0 | 8 | 40% |
| RSS 1.0 / RDF | 3 | 15% |
| RSS 0.90〜0.94 | 0 | 0% |
| Atom 0.3 | 0 | 0% |
| JSON Feed | 0 | 0% |

国内サービス12件に限定すると、RSS 2.0が5件、Atom 1.0が4件、RSS 1.0 / RDFが3件だった。RDFの3件はすべて国内サービスであり、日本語圏では世界的な傾向より残存率が高い。

### RSS 2.0

| 配信元 | 確認したフィード |
|---|---|
| note | [note公式フィード](https://note.com/info/rss) |
| WordPress | [WordPress News](https://wordpress.org/news/feed/) |
| Medium | [Artificial Intelligenceタグ](https://medium.com/feed/tag/artificial-intelligence) |
| Substack | [Platformer](https://platformer.news/feed) |
| Zenn | [TypeScriptトピック](https://zenn.dev/topics/typescript/feed) |
| Mozilla | [Mozilla Blog](https://blog.mozilla.org/en/feed/) |
| NHK | [主要ニュース](https://www.nhk.or.jp/rss/news/cat0.xml) |
| ITmedia | [ITmedia総合](https://rss.itmedia.co.jp/rss/2.0/itmedia_all.xml) |
| GIGAZINE | [GIGAZINE](https://gigazine.net/news/rss_2.0/) |

RSS 2.0はブログ、CMS、ニュースレター、国内ニュースで広く使われている。ポッドキャストでも、Apple PodcastsはRSS 2.0準拠を技術要件としている。

### Atom 1.0

| 配信元 | 確認したフィード |
|---|---|
| YouTube | [Google Developersチャンネル](https://www.youtube.com/feeds/videos.xml?channel_id=UC_x5XG1OV2P6uZZ5FSM9Ttw) |
| GitHub | [Node.js Releases](https://github.com/nodejs/node/releases.atom) |
| Qiita | [JavaScriptタグ](https://qiita.com/tags/javascript/feed.atom) |
| Reddit | [r/programming](https://www.reddit.com/r/programming/.rss) |
| arXiv | [cs.AI検索API](https://export.arxiv.org/api/query?search_query=cat:cs.AI&start=0&max_results=2) |
| はてなブログ | [はてなブログ開発ブログ](https://staff.hatenablog.com/feed) |
| connpass | [新着イベント](https://connpass.com/explore/ja.atom) |
| Publickey | [Publickey](https://www.publickey1.jp/atom.xml) |

Atom 1.0は動画、開発サービス、論文API、国内技術サービスで現役である。YouTube公式資料でも、YouTube Data APIの通知フォーマットはAtomフィードとして定義されている。

### RSS 1.0 / RDF

| 配信元 | 確認したフィード |
|---|---|
| はてなブックマーク | [IT人気エントリー](https://b.hatena.ne.jp/hotentry/it.rss) |
| 朝日新聞 | [主要ニュース](https://www.asahi.com/rss/asahi/newsheadlines.rdf) |
| Impress Watch | [総合フィード](https://www.watch.impress.co.jp/data/rss/1.0/ipw/feed.rdf) |

RSS 1.0 / RDFは主流ではないが、国内ニュース用途では無視できない。この3サービスを購読対象に含めない限り、現在のプロジェクトで維持する必要はない。

## 文字コード

20件のXML宣言は次の結果だった。

| 宣言 | 件数 |
|---|---:|
| UTF-8 | 19 |
| 未指定 | 1 |
| UTF-16 | 0 |
| Shift_JIS | 0 |
| ISO-8859-1 | 0 |

未指定の1件も実際の本文はUTF-8だった。

現在の実装は`content-type`と`encoding-sniffer`を使い、UTF-16、Shift_JIS、ISO-8859-1まで処理する。個人用収集器ではUTF-8だけを受け付け、その他は明示的に未対応エラーとする方が、対応形式を減らすより依存関係の削減効果が大きい。

## 形式ごとの方針

| 形式 | 方針 | 理由 |
|---|---|---|
| RSS 2.0 | 維持 | 現在の購読先で必要。CMS、ニュース、ポッドキャストで現役 |
| Atom 1.0 | 維持 | 現在の購読先で必要。YouTube、GitHub、Qiitaなどで現役 |
| RSS 1.0 / RDF | 標準対応から削除 | 国内ニュースを購読するときだけ追加すればよい |
| RSS 0.90〜0.94 | 削除 | 実測ゼロ。RSS 2.0で代替可能 |
| Atom 0.3 | 削除 | 標準化されたAtom 1.0を使う |
| JSON Feed 1.0 / 1.1 | 追加しない | 現在の購読先と実測対象で需要なし |
| 非UTF-8 XML | 削除 | 実測ゼロ。専用収集器では互換性コストに見合わない |

JSON Feed 1.1自体は有効な仕様だが、その公式仕様も「1形式だけ選ぶならRSS」を推奨している。新しい形式であることだけを理由に対応を追加しない。

## 実装への影響

現在の`src/rss/feed.ts`は、次の4依存をフィード処理のために直接使用している。

- `feedparser`
- `encoding-sniffer`
- `content-type`
- `html-to-text`

`feedparser`はRSS、Atom、RDFと古い派生形式を内部で処理する汎用パーサーである。そのため、RDF用テストや`Accept`ヘッダーの`application/rdf+xml`を削除するだけでは、パッケージ重量や内部の対応コードは減らない。

実際に軽量化する場合は、次の順で行う。

1. 対応契約をRSS 2.0、Atom 1.0、UTF-8に固定する。
2. RSS 1.0 / RDFのテストとMIME指定を削除する。
3. UTF-16、Shift_JIS、ISO-8859-1のテストを削除する。
4. `encoding-sniffer`と`content-type`を削除する。
5. `feedparser`を維持するか、RSS 2.0とAtom 1.0専用パーサーへ置き換えるかを、コード量と依存量の両方で比較する。

独自XMLパーサーへの置き換えは、相対URL、`xml:base`、Atom XHTML、CDATA、日付差異などの処理を自前化する。依存パッケージが減っても実装とテストが増える可能性があるため、「古い形式を消す」ことと「パーサーを書き直す」ことは別の判断として扱う。

ETag、Last-Modified、レスポンスサイズ制限、安定した記事ID、HTML概要のテキスト化は形式互換のための過剰実装ではなく、収集処理の正確性と安全性に関わるため維持する。

## 再検討条件

次のいずれかが発生した場合に限り、対応範囲を広げる。

- 新しい購読先がRSS 1.0 / RDFしか提供していない
- 新しい購読先が非UTF-8で配信している
- JSON Feedしか提供しない購読先を実際に追加する
- 不特定多数のURLを受け付ける汎用フィードリーダーへ役割を変更する

購読先追加時は、URLの拡張子や`Content-Type`だけで判断せず、実際のレスポンス本文のルート要素と文字コードを確認する。

## 参考資料

- [RSS 2.0 Specification](https://www.rssboard.org/rss-specification)
- [RFC 4287: The Atom Syndication Format](https://www.rfc-editor.org/info/rfc4287/)
- [RDF Site Summary (RSS) 1.0](https://validator.w3.org/feed/docs/rss1.html)
- [YouTube Data API: Subscribe to Push Notifications](https://developers.google.com/youtube/v3/guides/push_notifications)
- [Apple Podcasts: Podcast RSS feed requirements](https://podcasters.apple.com/support/823-podcast-requirements)
- [WordPress Feeds](https://developer.wordpress.org/advanced-administration/wordpress/feeds/)
- [JSON Feed Version 1.1](https://www.jsonfeed.org/version/1.1/)

*調査日: 2026-07-29*
