# credential-proxy.json 設定リファレンス

`config/credential-proxy.json` は Discord ボットが利用する AI プロバイダーの接続設定を定義するファイルです。

`config/credential-proxy.example.json` をコピーして編集してください。

## 必須フィールド

### `provider`

プロバイダーの識別子。`group.json` の `model.provider` に指定する値と一致させます。

- `pi-ai` の **KnownProvider**（`openai`, `anthropic`, `deepseek` 等）を指定する場合：組み込みモデル一覧が使用され、モデルIDの厳密なバリデーションが行われます。
- それ以外の任意の文字列：カスタムプロバイダーとして扱われ、モデルIDの検証はスキップされます（任意の文字列を `modelId` に指定可能）。

### `baseUrl`

API のベース URL。`{ENV_VAR}` 形式のプレースホルダを含めると、起動時に環境変数で置換されます。

```json
{ "baseUrl": "https://api.example.com/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1" }
```

プレースホルダが未解決の場合、そのエントリ全体がスキップされ、コンソールに警告が出力されます。

## オプションフィールド

### `envVars`

API キー等の環境変数名を配列で指定。設定ファイル読み込み時に `process.env` を参照し、存在する値を sandbox 内に secret として注入します。

```json
{ "envVars": ["OPENAI_API_KEY", "OPENAI_ORG_ID"] }
```

**挙動**:
- すべての環境変数が設定されている → 各変数を独立した secret として注入
- 一部のみ設定されている → 設定済みのものだけ注入し、未設定変数を警告ログで出力
- すべて未設定 → 静かにスキップ（プロバイダー自体が無効になったわけではない）
- 省略または空配列 `[]` → secret 注入を行わない（API Key が不要なローカルサーバー等に便利）

### `api`

`pi-ai` が使用する API プロトコル。カスタムプロバイダーでのみ有効。

有効な値:
- `"openai-completions"`（デフォルト）
- `"openai-responses"`
- `"openai-codex-responses"`
- `"anthropic-messages"`
- `"mistral-conversations"`
- `"bedrock-converse-stream"`
- `"google-generative-ai"`
- `"google-vertex"`

省略時は `"openai-completions"` が使用されます。

### `reasoning`

推論（Chain-of-Thought）対応の有無。カスタムプロバイダーでのみ有効。

- `true` → モデルが reasoning/thinking ブロックを出力可能
- `false`（デフォルト）→ 通常のテキスト生成

省略時は `false` です。

### `contextWindow`

モデルの最大コンテキスト長（トークン数）。カスタムプロバイダーでのみ有効。

省略時は `128000` が使用されます。

### `maxTokens`

1回の生成で出力可能な最大トークン数。カスタムプロバイダーでのみ有効。

省略時は `4096` が使用されます。

## 具体例

### KnownProvider（OpenAI）

```json
{
  "provider": "openai",
  "envVars": ["OPENAI_API_KEY"],
  "baseUrl": "https://api.openai.com/v1"
}
```

### カスタムプロバイダー（ローカル llama.cpp）

API Key 不要、最小構成:

```json
{
  "provider": "llama-cpp",
  "baseUrl": "http://localhost:8080/v1",
  "api": "openai-completions"
}
```

### カスタムプロバイダー（拡張設定）

```json
{
  "provider": "qwen3-local",
  "envVars": ["QWEN_API_KEY"],
  "baseUrl": "http://192.168.1.50:8081/v1",
  "api": "openai-completions",
  "reasoning": true,
  "contextWindow": 32768,
  "maxTokens": 4096
}
```

### baseUrl にプレースホルダを含むケース

```json
{
  "provider": "cloudflare",
  "envVars": ["CLOUDFLARE_API_KEY"],
  "baseUrl": "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1"
}
```

## 設計メモ

### なぜ envVars が空でも baseUrl は解決されるのか

`envVars` が省略または空配列の場合、API Key の注入は行われませんが、`baseUrl` のプレースホルダ解決と `allowHost` の登録は行われます。これにより、同一ホスト上の複数モデルやローカル推論サーバーへのアクセスが可能になります。

### カスタムプロバイダーのモデルID

KnownProvider でない場合、`modelId` は自由な文字列を指定できます（例: `"llama3-8b"`, `"custom-model-001"`）。`pi-ai` 側での検証は行われず、指定された文字列がそのまま API リクエストに使用されます。

### 将来的な拡張

以下は現在の実装では未対応ですが、設計上の検討事項です：

- **OneCLI への移行**: 外部ゲートウェイを経由したより安全なシークレット管理
- **グループごとのシークレット制御**: `groups/{name}/` 以下にプロバイダー設定を持つ
- **MCP サーバー用プロキシ**: ツール側の外部サービス接続にも同様の仕組みを適用
