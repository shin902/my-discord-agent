# Azure AD（Microsoft Entra ID）アプリ登録手順

Microsoft Graph API で Outlook メールを読むために必要な Azure AD アプリ登録の手順です。

---

## ⚠️ 重要：個人 Microsoft アカウントのみでの直接登録は非推奨（2024年8月〜）

**2024年6月（適用開始：2024年8月14日以降の新規登録）から、個人 Microsoft アカウント（outlook.jp / outlook.com / hotmail.com など）のみでは、ディレクトリなしでのアプリ登録ができなくなりました。**

以前は、個人アカウントでサインインした状態で「ディレクトリに属さないアプリ」として登録できましたが、この機能は廃止されています。現在 entra.microsoft.com や portal.azure.com でアプリ登録を試みると、以下のエラーが表示されます：

> 「ディレクトリの外部でアプリケーションを作成する機能は非推奨になりました。M365 開発者プログラムに参加するか、Azure でのサインアップを行って、新しいディレクトリを取得できます。」

アプリ登録には **Microsoft Entra テナント（ディレクトリ）が必要** です。テナントを取得するには、以下の2つの無料手段があります。

---

## 無料でテナントを取得する方法

### 方法A：Azure 無料アカウントでサインアップ（推奨）

#### メリット・デメリット

| 項目 | 内容 |
|------|------|
| 費用 | **クレジットカードまたはデビットカードが必要**（本人確認のため。登録時に $1 程度の一時保留が発生するが数日以内に解除される。課金はされない） |
| Entra ID アプリ登録 | **永続的に無料**。Microsoft Entra ID Free は Azure 無料アカウントに自動付帯し、無料試用期間（30日/$200クレジット）終了後もキャンセル不可・継続使用可能 |
| 課金リスク | 意図的に有料サービスを使用しない限り自動課金されない。ただし Pay-as-you-go へのアップグレード後に有料サービスを使用すると課金される |
| アプリ登録自体のコスト | **無料。登録数・認証数に対して Entra ID Free では課金なし** |

#### 手順

1. [https://azure.microsoft.com/ja-jp/free/](https://azure.microsoft.com/ja-jp/free/) を開く
2. **「Start free」** をクリック
3. 個人の Microsoft アカウント（outlook.jp / outlook.com など）でサインイン
4. 氏名・国/地域・電話番号を入力（SMS または通話で本人確認）
5. クレジットカードまたはデビットカードの情報を入力（本人確認のみ。即時課金なし）
   - プリペイドカードや仮想カードは使用不可
6. Microsoft カスタマー契約に同意して **「Sign up」**
7. 登録完了後、Azure Portal（portal.azure.com）または Entra 管理センター（entra.microsoft.com）に自動的に遷移する
   - **「既定のディレクトリ」（Default Directory）** という名前の Entra ID テナントが自動作成される
   - テナントのドメイン名は `xxxxx.onmicrosoft.com` 形式になる（`xxxxx` はサインアップ時に設定した名前）
   - このディレクトリが Entra 管理センターで表示されるテナントであり、**このディレクトリ内でアプリ登録を行えば OK**

> **注意**：Azure 無料アカウントに付帯する $200 クレジット（30日間）はオプションの有料サービス試用に使うものです。アプリ登録には不要であり、クレジットを使い切っても Entra ID Free とアプリ登録は引き続き利用できます。

---

### 方法B：Microsoft 365 開発者プログラム（2025年現在、個人は取得困難）

#### 現在の状況（2025年時点）

**個人の Microsoft アカウントのみでは、M365 E5 開発者サンドボックスを取得できない可能性が高い。** 2024年初頭からサンドボックスの配布資格が厳格化されており、以下のいずれかが必要です：

- Visual Studio Professional または Enterprise サブスクライバー（有料）
- Microsoft AI Cloud Partner Program 参加者（ISV Success、Solutions Partner 等）
- Premier/Unified Support 契約者

個人の無料アカウントでプログラムへの参加自体は可能ですが、サンドボックス（= E5 テナント）の取得画面で「現在資格がありません」と表示されるケースが多報告されています。Microsoft は将来的に制限を緩和する可能性があるとしていますが、現時点では確約なし。

#### 取得できた場合のメリット・デメリット

| 項目 | 内容 |
|------|------|
| 費用 | 無料（クレジットカード不要） |
| 有効期限 | 90日間。開発アクティビティが継続していれば**自動更新**（最大2年目安）。非アクティブな場合は失効 |
| 付帯機能 | Microsoft 365 E5 ライセンス（25ユーザー分）、Exchange Online、Teams 等を含む本格的な開発環境 |
| 安定性 | 開発者向けサンドボックスのため、本番用途には不向き。突然失効するリスクがある |

#### 手順（取得できた場合）

1. [https://developer.microsoft.com/en-us/microsoft-365/dev-program](https://developer.microsoft.com/en-us/microsoft-365/dev-program) を開く
2. **「Join now」** をクリックし、Microsoft アカウントでサインイン
3. プロフィール情報（国・用途等）を入力して登録
4. 「Set up E5 subscription」が表示された場合のみサンドボックス作成に進む
   - 表示されない場合は方法A（Azure 無料アカウント）を使用する
5. サンドボックスの管理者アカウント（`admin@xxxxx.onmicrosoft.com`）でサインインし直す

---

## 1. Microsoft Entra 管理センターにサインイン

Azure 無料アカウントまたは M365 開発者プログラムでテナントを作成後：

1. ブラウザで [https://entra.microsoft.com](https://entra.microsoft.com) を開く
2. テナントに紐付いた Microsoft アカウント（Azure 無料アカウントの場合は個人 outlook.jp / outlook.com アカウント）でサインイン
3. 右上のアカウントアイコン（またはテナント表示部分）をクリックし、**「既定のディレクトリ」**（`xxxxx.onmicrosoft.com`）が選択されていることを確認する
   - 別のテナントが選択されている場合は「ディレクトリの切り替え」から「既定のディレクトリ」を選ぶ

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

4. **「登録」**（Register）をクリック

> **重要**: 「サポートされているアカウントの種類」は必ず「個人用 Microsoft アカウントのみ」を選んでください。組織アカウント向けの設定を選ぶと個人アカウントでのサインインができません。

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

1. 左メニューの **「Authentication(Preview)」**を選択
2. **「リダイレクトURLの追加」**（Add a platform）→ **「モバイルアプリケーションとデスクトップアプリケーション」**（Mobile and desktop applications）を選択
3. リダイレクト URI のチェックリストが表示されるので、以下にチェックを入れる：
   ```
   https://login.microsoftonline.com/common/oauth2/nativeclient
   ```
   > **補足**: デバイスコードフロー自体はリダイレクト URI を使用しないため、このチェックは厳密には必須ではありません。ただし、アプリをパブリッククライアントとして認識させる目的と、将来的に他のネイティブフローを使う場合の備えとして、設定しておくことが推奨されます。
4. **「構成」**（Configure）をクリック
5. 「Authentication(Preview)」ページに戻ったら、ページ中央の **「設定」**セクションで **「パブリック クライアント フローを許可する」**（Allow public client flows）のトグルを **「はい」** に設定
6. ページ下部の **「保存」**（Save）をクリック

---

## 6. `credential-proxy.json` に設定を追記する

`config/credential-proxy.json` を開き、配列に以下のエントリを追加します。

`YOUR_CLIENT_ID` は手順 3 で控えたクライアント ID に置き換えてください。

### tenantId の指定について

テナントを作成した場合（Azure 無料アカウント / M365 開発者プログラム）、アプリが **「個人用 Microsoft アカウントのみ」** をサポートする設定であれば、`tenantId` は **`"consumers"`** を指定します。

> **なぜ `consumers` なのか**: 個人の Microsoft アカウント（outlook.jp / outlook.com / hotmail.com など）は、Azure/Entra のテナント GUID ではなく `consumers` エンドポイントで認証されます。テナントを持っていても、認証するユーザーが個人アカウントの場合は `consumers` を使用します。`"common"` はorganization + personal 両方を受け付けますが、MSAL のトークンキャッシュが正しく機能しない場合があるため、個人アカウント専用なら `"consumers"` が安全です。

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
data/graph-token-{provider}.json
```

`provider` は `credential-proxy.json` で指定したプロバイダー名です（例: `graph` の場合は `data/graph-token-graph.json`）。

以降の実行では、このキャッシュが有効な限りデバイスコード認証は不要です。

### 再認証が必要なケース

- `data/graph-token-{provider}.json` を削除した場合
- リフレッシュトークンの有効期限が切れた場合（通常90日間）
- `scopes` の設定を変更してアクセス許可を追加した場合
- アプリ登録のアクセス許可設定を変更した場合

再認証が必要なときは、`data/graph-token-{provider}.json` を削除してから再起動すれば、再度デバイスコードフローが起動します。

### 複数アカウントがキャッシュされている場合の動作

デバイスコードフローで再認証に成功すると、**古いアカウントはキャッシュから自動的に削除**されます。キャッシュは常に最新の1アカウントのみ保持されます。

次回起動時に複数アカウントが残っていた場合（例: 削除前のキャッシュが残っている場合）は、全アカウントに対してサイレント取得を順番に試み、最初に成功したものを使用します。すべて失敗した場合のみデバイスコードフローが起動します。

意図しないアカウントが使われていると思われる場合は、`data/graph-token-{provider}.json` を削除して再認証してください。

---

## 参考リンク

- [Microsoft Entra 管理センター](https://entra.microsoft.com)
- [Azure 無料アカウント作成](https://azure.microsoft.com/en-us/free/)
- [Microsoft 365 開発者プログラム](https://developer.microsoft.com/en-us/microsoft-365/dev-program)
- [アプリ登録の破壊的変更（2024年8月）- Microsoft Learn](https://learn.microsoft.com/en-us/entra/identity-platform/reference-breaking-changes)
- [アプリを Microsoft Entra ID に登録する方法 - Microsoft Learn](https://learn.microsoft.com/ja-jp/entra/identity-platform/quickstart-register-app)
- [OAuth 2.0 デバイス認証コード付与 - Microsoft Learn](https://learn.microsoft.com/ja-jp/entra/identity-platform/v2-oauth2-device-code)
- [Microsoft Graph でアプリを登録する - Microsoft Learn](https://learn.microsoft.com/ja-jp/graph/auth-register-app-v2)
- [Microsoft Entra ID Free の課金説明 - Microsoft Learn](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/microsoft-entra-id-free)
