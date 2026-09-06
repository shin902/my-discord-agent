# Credential設定リファレンス

`config/credentials.json` はAIプロバイダーと外部サービスの接続定義です。トップレベルは配列で、[credentials.example.json](../../config/credentials.example.json) をコピーして作成します。秘密値自体は書かず、ホスト側の環境変数等で管理してください。

この文書は設定の正本です。認証境界・Tool Proxyとの責務分担は [proxy.md](../proxy.md)、providerの実行ポリシーは [config.md](../config.md#configprovidersjson) を参照してください。schemaは [credential-proxy.ts](../../src/config/credential-proxy.ts)、モデルへの変換は [model.ts](../../src/agent/model.ts) にあります。

## 接続定義

| フィールド | 必須 | 意味 |
|---|---|---|
| `provider` | 必須 | 接続先の識別子。モデル用途ではAgentConfigの `model.provider` と一致させる |
| `baseUrl` | 必須 | upstreamのURL。HTTP(S) APIにはschemeを含むURLを指定する |
| `envVars` | 任意 | ホストで認証値を探す環境変数名の優先順リスト |
| `auth` | 任意 | envVarsで選んだ値の付与形式 |
| `msal` | 任意 | Microsoft Graph用の `tenantId`、`clientId`、`scopes` |
| `google` | 任意 | Google OAuth用の `clientId`、`clientSecretEnvVar`、`scopes` |

ホストでの読み込み元は既定で `config/credentials.json`、上書きは `CREDENTIALS_PATH` です。読み込み結果はキャッシュされ、設定変更には再起動が必要です。sandboxではホストが生成した `CREDENTIAL_PROXY_JSON` を読みます。これを秘密値の受け渡し手段として使わないでください。

### baseUrlのプレースホルダ

`{ENV_VAR}` をホストの環境変数で置換できます。

```json
{
  "provider": "custom-api",
  "baseUrl": "https://api.example.com/accounts/{ACCOUNT_ID}/v1"
}
```

未解決のプレースホルダがあるentryは、managerが警告してsandbox向け定義から除外します。ホストの設定配列から削除されるわけではなく、forwarding requestは502になります。カスタムモデルの起動時検証では未解決URLをエラーにします。

### envVarsと認証

`envVars` は **先頭から最初の空でない環境変数値を1つ選ぶ** 指定です。複数の値をそれぞれsandboxへsecret注入する機能ではありません。

```json
{
  "provider": "custom-api",
  "envVars": ["PRIMARY_API_KEY", "FALLBACK_API_KEY"],
  "baseUrl": "https://api.example.com/v1",
  "auth": { "type": "bearer" }
}
```

Credential forwardingの認証処理は `msal → google → envVars` の優先順です。

| `auth.type` | upstreamへの付与 |
|---|---|
| 省略 / `bearer` | `Authorization: Bearer <value>` |
| `query-token` | `queryParam` のquery parameterへ付与。既定名は `token` |
| `basic` | `Authorization: Basic base64("<username>:<value>")`。username既定値は `x-access-token` |

OAuth設定がなく `envVars` が空でない配列の場合、forwarding時に受信したAuthorizationを除去してから認証を付与します。全候補が空ならAuthorizationを付けません。`envVars` が省略・空配列でOAuth設定もない場合は、forwarding時のAuthorizationを書き換えません。

sandbox向け定義を生成するmanagerの挙動は次のとおりです（host専用tool providerの除外は [proxy.md](../proxy.md#tool-proxy) を参照）。

- 全候補が未設定・空の場合、そのentryをsandbox向け定義から除外します。
- 一部のみ設定されている場合は警告し、entryを残します。利用する認証値は最初の設定済み候補です。
- `envVars` が省略・空配列なら、それだけを理由にはentryを除外しません。APIキー不要のローカルAPIにも使えます。
- 渡すentryから `envVars`、`auth`、`msal`、`google`、`redditCookie` を除去し、`baseUrl` をproxy URLへ置換します。環境変数名も実キーもsandboxへ渡しません。

`auth` はCredential forwardingの設定です。Tool Proxyのhost executorはcapability別の認証処理を使うため、任意の `auth` が全toolへ適用されるとは限りません。

### OAuth・Reddit

MSALとGoogle OAuthはホスト側で初期化します。`google.clientSecretEnvVar` が指す環境変数が未設定・空の場合は警告してそのproviderのGoogle Auth初期化をスキップします。認証手順は [Azure](../guides/azure-app-registration.md) / [Google](../guides/google-cloud-oauth-setup.md) を参照してください。

schemaには旧 `redditCookie`（`cookieFile` 既定値 `data/reddit-cookies.json`、`maxAgeDays` 既定値7）が残っていますが、現行のReddit認証設定には使いません。[専用Tool Runtimeのセットアップ](../guides/reddit-cookie-setup.md) を参照してください。

## モデル解決

KnownProviderで `forceCustom` が未指定・falseの場合、pi-aiの組み込みモデル一覧からmodelIdを検証・解決します。この経路はcredentialsのモデル用 `baseUrl` / `api` / `compat` 等をカスタムモデル定義として適用しません。

未知のprovider名、または `forceCustom: true` の場合は、このentryからカスタムモデルを作ります。modelIdは組み込み一覧で検証せず、そのまま使用します。KnownProvider名でもproxy URL・カスタムAPI定義をモデルへ適用したい場合は `forceCustom: true` を指定します。

| フィールド | カスタムモデルでの挙動 |
|---|---|
| `forceCustom` | KnownProvider名でもカスタムモデル解決を選ぶ |
| `api` | 省略時 `openai-completions` |
| `reasoning` | 明示値を優先。省略時は有効な `compat.thinkingFormat` の有無で決定 |
| `contextWindow` | 正の整数。省略時128000 |
| `maxTokens` | 正の整数。省略時4096 |
| `models[modelId].input` | `text` / `image` の配列。省略時は `["text"]` |
| `compat` | 下記のOpenAI completions互換設定 |

`api` のschema上の許容値は `openai-completions`、`openai-responses`、`azure-openai-responses`、`openai-codex-responses`、`anthropic-messages`、`mistral-conversations`、`bedrock-converse-stream`、`google-generative-ai`、`google-vertex` です。許容値であることは、任意のupstream・認証形式で動作する保証ではありません。

### compatとthinkingLevel

`compat` はカスタムモデルの `api: "openai-completions"` 用です。

| フィールド | 意味 |
|---|---|
| `thinkingFormat` | `openai` / `openrouter` / `deepseek` / `zai` / `qwen-chat-template` を直接指定 |
| `thinkingLevelMap` | `off` は必須、`minimal` / `low` / `medium` / `high` / `xhigh` は任意の文字列マッピング |
| `requiresReasoningContentOnAssistantMessages` | pi-aiへ渡すreasoning_content互換フラグ |

`thinkingFormat` の名前による自動補正は行いません。`qwen` / `ollama` は許容値ではありません。`reasoning: false` を明示するか、`thinkingFormat` がない場合、modelの `compat` 自体は付与されません。`thinkingLevelMap` は `compat` から分離してmodelのトップレベルへ渡されます。

実際に選ぶthinkingLevelはAgentConfigの `model.thinkingLevel` です。runnerの省略時は `off` ですが、サーバーへ送られる形式や効果はAPI・モデル・compatに依存します。thinkingLevelごとの固定トークン予算を全provider共通の保証として扱わないでください。

### カスタムモデルの例

```json
{
  "provider": "local-qwen",
  "baseUrl": "http://localhost:8080/v1",
  "api": "openai-completions",
  "contextWindow": 65536,
  "maxTokens": 4096,
  "compat": { "thinkingFormat": "qwen-chat-template" },
  "models": {
    "vision-model": { "input": ["text", "image"] }
  }
}
```

これは設定形式の例であり、upstreamのモデル名・chat template・thinking対応は別途合わせる必要があります。CLIProxyAPIを使う例は [専用ガイド](../guides/codex-oauth-cliproxyapi.md)、他の接続例は [credentials.example.json](../../config/credentials.example.json) を参照してください。

## 歴史的資料

[thinkingFormat自動補正の廃止設計](../spec/credential-proxy-thinking-format-cleanup.md) は変更当時の理由を残す資料です。そこにある旧ファイル名・旧schema・実装前の処理を現行設定として使わないでください。
