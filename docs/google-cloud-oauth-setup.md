# Google Cloud OAuth 設定手順（Google Calendar）

Google Calendar API を `google-calendar` プロバイダー（`src/tools/calendar.ts`）から使うために必要な、Google Cloud Console での OAuth クライアント設定手順です。

---

## 1. プロジェクトの作成と Calendar API の有効化

1. [Google Cloud Console](https://console.cloud.google.com/) を開く（既存プロジェクトがあれば流用可）
2. 新規プロジェクトを作成（または既存プロジェクトを選択）
3. 左メニュー「APIとサービス」→「ライブラリ」を開く
4. **Google Calendar API** を検索し、「有効にする」をクリック

---

## 2. OAuth 同意画面の設定

1. 左メニュー「APIとサービス」→「OAuth 同意画面」を開く
2. User Type は **「外部」** を選択（個人 Google アカウントの場合）
3. アプリ名・サポートメール等の必須項目を入力
4. 「スコープ」の追加で `https://www.googleapis.com/auth/calendar` を追加

> **重要**: アプリの公開ステータスは「テスト」のままで問題ない（検証申請は不要）。ただし**テストユーザーに自分の Google アカウントを追加していないと、認証時に「このアプリは確認されていません」エラーで先に進めない**。「OAuth 同意画面」→「テストユーザー」で自分のアカウントを追加すること。

---

## 3. OAuth クライアント ID の作成

1. 左メニュー「APIとサービス」→「認証情報」を開く
2. 「+ 認証情報を作成」→「OAuth クライアント ID」を選択
3. アプリケーションの種類で **「TV と入力制限のあるデバイス」**（TVs and Limited Input devices）を選択
4. 名前を入力して作成
5. 表示される **クライアントID** と **クライアントシークレット** を控える

> デバイス認証フロー（Device Authorization Grant）を利用するため、この種類を選ぶ。「デスクトップアプリ」等を選ぶとデバイスフローのエンドポイントが利用できない場合がある。

---

## 4. `config/config.json` と `.env` への設定

`config/config.json` の `credentials` 配列に追加（`config.example.json` も参照）:

```json
{
  "provider": "google-calendar",
  "baseUrl": "https://www.googleapis.com/calendar/v3",
  "google": {
    "clientId": "手順3で控えたクライアントID",
    "clientSecretEnvVar": "GOOGLE_CALENDAR_CLIENT_SECRET",
    "scopes": ["https://www.googleapis.com/auth/calendar"]
  }
}
```

`.env` に以下を追記:

```
GOOGLE_CALENDAR_CLIENT_SECRET=手順3で控えたクライアントシークレット
```

`clientSecretEnvVar` が指す環境変数が未設定の場合、起動時に警告ログが出てこのプロバイダーの初期化はスキップされる（リクエストは 502 になる）。

---

## 5. 初回起動時のデバイスコード認証フロー

calendar 系ツール（`list_events` 等）を最初に呼んだタイミングで、ホストプロセスの標準出力に以下のようなログが表示される：

```
[google-auth:google-calendar] 認証が必要です
[google-auth:google-calendar] https://www.google.com/device を開き、コード ABCD-EFGH を入力してください
```

1. 表示された URL をブラウザで開く
2. 表示されたコードを入力する
3. 手順2でテストユーザーに追加した Google アカウントでサインインし、カレンダーへのアクセスを許可する

認証が完了すると、エージェントの処理が自動的に再開される。

---

## 6. トークンキャッシュ

認証に成功したアクセストークン・リフレッシュトークンは以下のファイルに保存される（パーミッション 0600）：

```
data/google-token-{provider}.json
```

`provider` は `config/config.json` で指定したプロバイダー名（例: `google-calendar` の場合は `data/google-token-google-calendar.json`）。

以降はこのキャッシュからリフレッシュトークンでアクセストークンが自動更新されるため、再認証は不要。

### 再認証が必要なケース

- `data/google-token-{provider}.json` を削除した場合
- リフレッシュトークンが失効・無効化された場合
- `scopes` を変更してアクセス許可を追加した場合
- OAuth 同意画面の設定を変更した場合

再認証が必要なときは、`data/google-token-{provider}.json` を削除してから再起動すれば、再度デバイスコードフローが起動する。

---

## 参考リンク

- [Google Cloud Console](https://console.cloud.google.com/)
- [OAuth 2.0 for TV and Limited-Input Device Applications - Google Identity](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
- [Google Calendar API リファレンス](https://developers.google.com/calendar/api/v3/reference)
