# Reddit OAuth 設定手順（agent-reach の reddit サービス）

`agent-reach` ツールの reddit サービス（`src/tools/agent-reach.ts`）が `oauth.reddit.com` にアクセスするために必要な、Reddit アプリ登録の手順です。

Reddit は未認証の `.json` API アクセスを一律ブロックしているため、`client_credentials` グラント（アプリ単位の読み取り専用トークン）での認証が必須になっています。個人・非商用利用の Free Access Tier は無料（100 QPM まで）。

---

## 1. Reddit アプリの作成

1. Reddit にログインした状態で [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) を開く
2. 画面下部の「create another app...」（または「create app」）をクリック
3. 以下を入力する:
   - **name**: 任意の名前（例: `my-discord-agent`）
   - **type**: **`script`** を選択（`client_credentials` グラントが使えるのは script タイプのみ）
   - **description**: 任意（省略可）
   - **about url**: 空欄でよい
   - **redirect uri**: `http://localhost` など適当な値で構わない（script タイプではリダイレクトフローを使わないため実際には使用されない。ただし入力必須）
4. 「create app」をクリックして作成する

作成後、アプリ名の下に表示される短い英数字文字列が **client_id**、「secret」欄の値が **client_secret**。

> **重要**: script タイプのアプリは、作成したRedditアカウントに紐づく。アカウント停止・削除されるとトークンも無効になる。bot専用アカウントでの作成を推奨する。

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
