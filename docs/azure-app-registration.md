# Azure AD（Microsoft Entra ID）アプリ登録手順

Microsoft Graph API で Outlook メールを読むために必要な Azure AD アプリ登録の手順です。

## 前提：費用について

**Azure サブスクリプション（課金）は不要です。**
アプリ登録自体は無料で行えます。ただし、Microsoft Entra 管理センターにアクセスするには、**Microsoft アカウント（outlook.com / hotmail.com / outlook.jp など）** があれば十分です。クレジットカードや Azure 有料サブスクリプションは必要ありません。

---

## 1. Microsoft Entra 管理センターにサインイン

1. ブラウザで [https://entra.microsoft.com](https://entra.microsoft.com) を開く
2. 個人の Microsoft アカウント（outlook.jp / outlook.com / hotmail.com など）でサインイン

> **補足**: `portal.azure.com` からでもアプリ登録は可能ですが、`entra.microsoft.com` のほうが ID 関連の機能に直接アクセスしやすいです。

---

## 2. 新規アプリを登録する

1. 左側のメニューから **「アプリの登録」**（App registrations）を選択
   - 見当たらない場合は左上の「≡」→「Identity」→「アプリケーション」→「アプリの登録」
2. 上部の **「+ 新規登録」**（New registration）をクリック
3. 以下を入力する：

| 項目 | 値 |
|------|-----|
| **名前** | `my-discord-agent`（任意） |
| **サポートされているアカウントの種類** | 「**個人用 Microsoft アカウントのみ**」（Personal Microsoft accounts only） |
| **リダイレクト URI** | 空欄のまま（後で設定） |

4. **「登録」**（Register）ボタンをクリック

> **重要**: 「サポートされているアカウントの種類」は必ず「個人用 Microsoft アカウントのみ」を選んでください。組織アカウント向けの設定を選ぶと `consumers` テナントで動作しません。

---

## 3. クライアント ID を控える

登録完了後、アプリの概要ページが表示されます。

- **アプリケーション（クライアント）ID**（Application (client) ID）をコピーして控えておく

例: `12345678-abcd-1234-efgh-1234567890ab`

このIDが後述の `credential-proxy.json` に記載する `clientId` になります。

---

## 4. API アクセス許可を設定する

1. 左メニューの **「API のアクセス許可」**（API permissions）を選択
2. **「+ アクセス許可の追加」**（Add a permission）をクリック
3. 「Microsoft Graph」を選択
4. **「委任されたアクセス許可」**（Delegated permissions）を選択
5. 検索ボックスに `Mail.Read` と入力して選択
6. **「アクセス許可の追加」**（Add permissions）をクリック

> **管理者の同意は不要です。** `Mail.Read` は委任型（Delegated）のアクセス許可であり、ユーザー本人がサインインして同意するため、管理者による一括同意は必要ありません。

---

## 5. パブリッククライアントフローを有効化する

デバイスコードフローを使うには、アプリを「パブリッククライアント」として設定する必要があります。

1. 左メニューの **「認証」**（Authentication）を選択
2. **「プラットフォームを追加」**（Add a platform）→ **「モバイルアプリケーションとデスクトップアプリケーション」**（Mobile and desktop applications）を選択
3. リダイレクト URI のチェックリストが表示されるので、以下にチェックを入れる：
   ```
   https://login.microsoftonline.com/common/oauth2/nativeclient
   ```
4. **「構成」**（Configure）をクリック
5. ページ下部の **「詳細設定」**（Advanced settings）セクションで **「パブリック クライアント フローを許可する」**（Allow public client flows）を **「はい」** に設定
6. ページ上部の **「保存」**（Save）をクリック

---

## 6. `credential-proxy.json` に設定を追記する

`config/credential-proxy.json` を開き、配列に以下のエントリを追加します。

`YOUR_CLIENT_ID` は手順 3 で控えたクライアント ID に置き換えてください。

```json
{
  "provider": "graph",
  "baseUrl": "https://graph.microsoft.com/v1.0",
  "msal": {
    "tenantId": "consumers",
    "clientId": "YOUR_CLIENT_ID",
    "scopes": ["https://graph.microsoft.com/Mail.Read"]
  }
}
```

追記後の `credential-proxy.json` 全体の例：

```json
[
  {
    "provider": "openai",
    "envVars": ["OPENAI_API_KEY"],
    "baseUrl": "https://api.openai.com/v1"
  },
  {
    "provider": "graph",
    "baseUrl": "https://graph.microsoft.com/v1.0",
    "msal": {
      "tenantId": "consumers",
      "clientId": "12345678-abcd-1234-efgh-1234567890ab",
      "scopes": ["https://graph.microsoft.com/Mail.Read"]
    }
  }
]
```

> **`tenantId: "consumers"` について**: 個人の Microsoft アカウント（outlook.jp / outlook.com / hotmail.com など）を使う場合、テナント ID は必ず `"consumers"` を指定します。`"common"` や組織の GUID を指定すると個人アカウントではサインインできません。

---

## 7. 初回起動時のデバイスコード認証フロー

初めて graph プロバイダを使う操作が実行されると、以下のフローで認証が行われます。

1. エージェントまたはホストプロセスのログに以下のようなメッセージが表示されます：

   ```
   To sign in, use a web browser to open the page https://microsoft.com/devicelogin
   and enter the code XXXXXXXX to authenticate.
   ```

2. ブラウザで [https://microsoft.com/devicelogin](https://microsoft.com/devicelogin) を開く

3. 表示されたコード（例: `XXXXXXXX`）を入力する

4. 個人の Microsoft アカウントでサインインし、`Mail.Read` のアクセス許可に同意する

5. 認証が完了すると、エージェントの処理が自動的に再開されます

---

## 8. トークンキャッシュ

認証に成功したアクセストークン・リフレッシュトークンは以下のファイルに保存されます：

```
data/graph-token.json
```

以降の実行では、このキャッシュが有効な限りデバイスコード認証は不要です。

### 再認証が必要なケース

- `data/graph-token.json` を削除した場合
- リフレッシュトークンの有効期限が切れた場合（通常90日間）
- `scopes` の設定を変更してアクセス許可を追加した場合
- アプリ登録のアクセス許可設定を変更した場合

再認証が必要なときは、`data/graph-token.json` を削除してから再起動すれば、再度デバイスコードフローが起動します。

---

## 参考リンク

- [Microsoft Entra 管理センター](https://entra.microsoft.com)
- [アプリを Microsoft Entra ID に登録する方法 - Microsoft Learn](https://learn.microsoft.com/ja-jp/entra/identity-platform/quickstart-register-app)
- [OAuth 2.0 デバイス認証コード付与 - Microsoft Learn](https://learn.microsoft.com/ja-jp/entra/identity-platform/v2-oauth2-device-code)
- [Microsoft Graph でアプリを登録する - Microsoft Learn](https://learn.microsoft.com/ja-jp/graph/auth-register-app-v2)
