# Reddit OAuth が使えない理由（調査記録）

`agent-reach` の reddit サービス（`templates/SKILLS/agent-reach/scripts/agent-reach.sh`）の実装を検討する過程で、Reddit の `client_credentials` グラント（アプリ単位の読み取り専用トークン）による OAuth 認証を最初に試みたが、実装には至らなかった。その理由をここに記録する。実際に採用した方式は [`docs/reddit-cookie-setup.md`](./reddit-cookie-setup.md) を参照。

> [!WARNING]
> **現状: 新規ユーザーが個人で client_id / client_secret を取得すること自体が難しい。**
>
> - `reddit.com/prefs/apps` でアプリを新規作成しようとすると `In order to create an application or use our API you can read our full policies here: ...Responsible-Builder-Policy` というエラーで弾かれ、申請フォームにすら進めないケースが本プロジェクトの検証で実際に発生した
> - 同様の報告は他のOSS([gallery-dl#8559](https://github.com/mikf/gallery-dl/issues/8559)、[jordanburke/reddit-mcp-server#8](https://github.com/jordanburke/reddit-mcp-server/issues/8))でも複数あり、開発者からの解決策の提示も無い
> - OAuth を経由しない代替手段（`.json` への直接アクセス、通常HTMLページのcurl取得、anonymousモード相当のリクエスト）も全て試したが、いずれも「Please wait for verification」「You've been blocked by network security」というbot対策ページが返るだけで、実コンテンツの取得には至らなかった
> - headless Chromium(Playwright)でアクセスしても、`chrome-headless-shell`バイナリは同様にJSチャレンジでブロックされることを確認した(ただし Xvfb 上でフルChromiumを `headless: false` 起動すると通過することが分かった。これが現在のクッキー方式の前提になっている)
>
> つまり、2025年11月の Responsible Builder Policy 改定以降、**個人開発者がこの OAuth 方式を使える状態にできるかどうかは Reddit 側の審査結果に完全に依存し、見通しが立たない。**

## 参考リンク

- [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
- [Reddit API ドキュメント](https://www.reddit.com/dev/api/)
- [Reddit Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
