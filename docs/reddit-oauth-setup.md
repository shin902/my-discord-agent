# Reddit OAuth 設定手順（agent-reach の reddit サービス）

`agent-reach` ツールの reddit サービス（`src/tools/agent-reach.ts`）が `oauth.reddit.com` にアクセスするために必要な、Reddit アプリ登録の手順です。

Reddit は未認証の `.json` API アクセスを一律ブロックしているため、`client_credentials` グラント（アプリ単位の読み取り専用トークン）での認証が必須になっています。個人・非商用利用の Free Access Tier は無料（100 QPM まで）── ただし **2025年11月の Responsible Builder Policy 改定以降、個人がこのトークンを実際に取得するのはかなり厳しくなっている。** 以下、本プロジェクトで実際に確認した状況を記す。

> [!WARNING]
> **現状（2026年6月時点の調査結果）: 新規ユーザーが個人で client_id / client_secret を取得すること自体が難しい。**
>
> - `prefs/apps` でアプリを新規作成しようとすると `In order to create an application or use our API you can read our full policies here: ...Responsible-Builder-Policy` というエラーで弾かれ、申請フォームにすら進めないケースが本プロジェクトの検証でも実際に発生した
> - 同様の報告は [gallery-dl#8559](https://github.com/mikf/gallery-dl/issues/8559) でも多数あり、Reddit からは `You cannot create any more applications if you are a developer on 0 or more applications, reach out to us...` という案内が出る
> - 実際に「reach out」して個別に申請したユーザーも、Reddit 側から**「Responsible API Requirements に違反するスクレイパー」として明確に拒否**されている
> - OAuth を経由しない代替手段（`.json` への直接アクセス、通常HTMLページのcurl取得、匿名クッキー使用）も全て試したが、`.json` は403、通常HTMLは「Please wait for verification」というbot検証ページが返るだけで、いずれも実コンテンツの取得には至らなかった（IPレピュテーション依存のヒューリスティックなため、別環境では通る可能性はあるが保証はできない）
>
> つまり**現時点で個人開発者がこの reddit 機能を実際に使える状態にできるかどうかは、Reddit 側の審査結果に完全に依存し、見通しが立たない。** 以下の手順はあくまで「申請がもし通った場合」のための設定方法であり、申請自体が通る保証はないことを理解した上で進めること。

---

## 1. Reddit アプリの作成・申請

1. Reddit にログインした状態で [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) を開く
2. 画面下部の「開発者ならアプリを作ってもいいです！」をクリック
3. 以下を入力する:
   - **name**: 任意の名前（例: `my-discord-agent`）
   - **スクリプト** を選択（`client_credentials` グラントが使えるのは script タイプのみ）
   - **description**: 任意（省略可）
   - **about url**: 空欄でよい
   - **redirect uri**: `http://localhost` など適当な値で構わない（script タイプではリダイレクトフローを使わないため実際には使用されない。ただし入力必須）
4. reCAPTCHAを認証した後で「アプリを作成」をクリックして申請する

承認後、アプリ名の下に表示される短い英数字文字列が **client_id**、「secret」欄の値が **client_secret**。

> **重要**: script タイプのアプリは、作成したRedditアカウントに紐づく。アカウント停止・削除されるとトークンも無効になる。bot専用アカウントでの作成を推奨するが、アカウントの活動量も審査対象になるため、作成直後の新規アカウントでは承認されにくい可能性がある。

---

## 2. `config/config.json` と `.env` への設定

`config/config.json` の `credentials` 配列に追加（`config.example.json` も参照）:

```json
{
  "provider": "reddit",
  "baseUrl": "https://oauth.reddit.com",
  "reddit": {
    "clientId": "手順1で控えたclient_id",
    "clientSecretEnvVar": "REDDIT_CLIENT_SECRET"
  }
}
```

`.env` に以下を追記:

```
REDDIT_CLIENT_SECRET=手順1で控えたclient_secret
```

`clientSecretEnvVar` が指す環境変数が未設定の場合、起動時に警告ログが出てこのプロバイダーの初期化はスキップされる（リクエストは 502 になる）。

---

## 3. 認証フロー（デバイス認証等は不要）

Google Calendar の OAuth と異なり、Reddit の `client_credentials` グラントはアプリ単位の認可のため、ブラウザでの認証手続きやデバイスコード入力は不要。`.env` と `config/config.json` を設定して再起動すれば、`agent-reach` で reddit の URL を渡した時点で自動的にアクセストークンが取得される。

アクセストークンは `src/proxy/reddit-auth.ts` がホストプロセスのメモリにのみキャッシュし、期限切れ（約1時間）の60秒前に自動で再取得する。ディスクへの永続化は行わない（再起動時は再取得するだけで再認証は不要）。

---

## 4. 動作確認

Discord 上で reddit の投稿 URL を含むメッセージを送り、`agent-reach` ツールが呼ばれたときにエラーにならず markdown が保存されれば成功。

失敗する場合はホストプロセスの標準出力に以下のようなログが出ているか確認する:

```
[credential-proxy] REDDIT_CLIENT_SECRET が未設定のため provider reddit の Reddit Auth をスキップします
[credential-proxy] reddit token 取得失敗: ...
```

- `REDDIT_CLIENT_SECRET が未設定` → `.env` の設定漏れ、または再起動していない
- `invalid_client` エラー → `clientId` / `client_secret` の値の誤り、またはアプリの type が `script` になっていない
- `429` / レート制限エラー → Free Tier の 100 QPM を超えている（通常の個人利用では発生しない）

---

## 参考リンク

- [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
- [Reddit API ドキュメント](https://www.reddit.com/dev/api/)
- [Reddit OAuth2 ドキュメント (reddit-archive/reddit)](https://github.com/reddit-archive/reddit/wiki/OAuth2)
