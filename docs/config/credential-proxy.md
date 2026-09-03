# config/credentials.json 設定リファレンス

`config/credentials.json` は Discord ボットが利用する AI プロバイダーの接続設定を定義します。トップレベルは配列です。

`config/credentials.example.json` をコピーして `config/credentials.json` を作成し、編集してください。

## 必須フィールド

### `provider`

プロバイダーの識別子。`config/groups.json` の `groups[].model.provider` に指定する値と一致させます。

- `pi-ai` の **KnownProvider**（`openai`, `anthropic`, `deepseek` 等）を指定する場合：組み込みモデル一覧が使用され、モデルIDの厳密なバリデーションが行われます。
- それ以外の任意の文字列：カスタムプロバイダーとして扱われ、モデルIDの検証はスキップされます（任意の文字列を `modelId` に指定可能）。

### `baseUrl`

API のベース URL。**`http://` または `https://` のプロトコルを必ず含めてください**（例: `http://localhost/v1`）。プロトコルがない場合は起動時にバリデーションエラーになります。

`{ENV_VAR}` 形式のプレースホルダを含めると、起動時に環境変数で置換されます。

```json
{ "baseUrl": "https://api.example.com/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1" }
```

プレースホルダが未解決の場合、そのエントリ全体がスキップされ、コンソールに警告が出力されます。

## オプションフィールド

### `forceCustom`

`provider` の値が `pi-ai` の **KnownProvider**（`groq`, `openai` 等）と衝突する場合でも、credential-proxy 側のカスタムプロバイダー設定（`baseUrl`・`envVars`・`compat` 等）を優先して使用する。

`pi-ai` が標準サポートしているプロバイダー名と同じ `provider` を指定すると、通常はそちらの組み込み設定（モデル一覧・baseUrl 等）が優先され、`credentials` 側の設定が無視される。`forceCustom: true` を指定すると、`provider` が KnownProvider と一致していてもカスタムプロバイダーとして解決される。

```json
{
  "provider": "groq",
  "forceCustom": true,
  "envVars": ["GROQ_API_KEY"],
  "baseUrl": "https://api.groq.com/openai/v1"
}
```

省略時は `false`（KnownProvider と衝突する場合は組み込み設定が優先される）。

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

### `auth`

`envVars` で見つかった API キーを upstream に渡す形式を指定します。

省略時は `Bearer` 認証です。

```json
{ "envVars": ["OPENAI_API_KEY"], "auth": { "type": "bearer" } }
```

query parameter で token を要求する API では `query-token` を指定します。

```json
{
  "provider": "query-auth-api",
  "envVars": ["QUERY_AUTH_API_TOKEN"],
  "baseUrl": "https://api.example.com",
  "auth": { "type": "query-token", "queryParam": "token" }
}
```

`queryParam` を省略した場合は `"token"` が使われます。

Basic 認証が必要な API では `basic` を指定します。

```json
{
  "provider": "basic-auth-api",
  "envVars": ["BASIC_AUTH_API_TOKEN"],
  "baseUrl": "https://api.example.com",
  "auth": { "type": "basic", "username": "api-user" }
}
```

`username` を省略した場合は `"x-access-token"` が使われます。`Authorization: Basic base64("<username>:<token>")` として注入されます。

### `api`

`pi-ai` が使用する API プロトコル。カスタムプロバイダーでのみ有効。

有効な値:
- `"openai-completions"`（デフォルト）
- `"openai-responses"`
- `"openai-codex-responses"`（ChatGPT OAuth credential と Codex backend を直接扱う場合）
- `"anthropic-messages"`
- `"mistral-conversations"`
- `"bedrock-converse-stream"`
- `"google-generative-ai"`
- `"google-vertex"`

省略時は `"openai-completions"` が使用されます。

Codex OAuth を CLIProxyAPI サイドカー経由で使う例:

```json
{
  "provider": "codex-oauth",
  "forceCustom": true,
  "envVars": ["CLIPROXY_API_KEY"],
  "baseUrl": "http://localhost:8317/v1",
  "api": "openai-responses",
  "contextWindow": 192000,
  "maxTokens": 8192
}
```

`credential-proxy-server` が `Authorization: Bearer $CLIPROXY_API_KEY` を upstream の CLIProxyAPI へ注入するため、サンドボックスコンテナには CLIProxyAPI のローカル API キーも ChatGPT/Codex OAuth token も渡らない。詳しい手順は `docs/guides/codex-oauth-cliproxyapi.md` を参照。

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

> **⚠️ reasoning モデルを使う場合は必ず明示指定すること**
>
> `reasoning: true` のモデル（Qwen3 等）は `<think>` ブロックと実際の返答が **同じ `maxTokens` 予算を共有する**。
> デフォルトの `4096` では thinking がトークンを使い切り、`content: []`（空返答）が返る。
> ローカル LLM にはコスト制約がないため、`16384` 以上を指定する。
>
> ただし `compat.thinkingFormat` で thinking を OFF にできる場合は `4096` のまま運用して問題ない（→ `compat` 参照）。

### `compat`

`pi-ai` の OpenAI-compatible ストリームレイヤーに渡す互換設定のオーバーライド。カスタムプロバイダーでのみ有効。

現在サポートするフィールド:

| フィールド | 型 | 説明 |
|---|---|---|
| `thinkingFormat` | 文字列 | thinking ON/OFF の制御方法をプロバイダー別に指定。`pi-ai` が解釈する具体値を直接指定する（自動補正は行わない） |
| `thinkingLevelMap` | オブジェクト | `thinkingLevel` をサーバー固有の effort 値にマッピングする（→ 後述） |

**`thinkingFormat` に指定できる値**:

| 値 | 対象サーバー | 挙動 |
|---|---|---|
| `"qwen-chat-template"` | llama.cpp / llama-cpp-python | `chat_template_kwargs.enable_thinking` + `preserve_thinking` を付与 |
| `"openrouter"` | Ollama（v0.9.0+）OpenAI 互換 API / OpenRouter | `reasoning.effort` を付与 |
| `"deepseek"` | DeepSeek 互換 | `thinking.type: enabled/disabled` を付与 |
| `"zai"` | ZAI 互換 | `pi-ai` の定義に従う |
| `"openai"` | OpenAI 標準（デフォルト） | thinking 関連フィールドは送らない |

### `compat.thinkingLevelMap`

`thinkingLevel`（`"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`）をサーバー固有の effort 値にマッピングする。Ollama の OpenAI 互換 API（`reasoning.effort`）など、`reasoning.effort` の値体系が `pi-ai` のデフォルトと異なるサーバーで指定する。

```json
{
  "compat": {
    "thinkingFormat": "openrouter",
    "thinkingLevelMap": { "off": "none", "minimal": "low", "xhigh": "high" }
  }
}
```

省略時は `pi-ai` のデフォルトマップが使われる（`openrouter` なら `off`/`minimal`/`low`/`medium`/`high`/`xhigh` がそのまま effort 値になる）。

**thinking を OFF にする典型例（llama-cpp + Qwen3）**:

```json
{
  "provider": "llama-cpp",
  "baseUrl": "http://localhost:8080/v1",
  "api": "openai-completions",
  "contextWindow": 65536,
  "maxTokens": 4096,
  "compat": { "thinkingFormat": "qwen-chat-template" }
}
```

`thinkingFormat` を設定すると自動的に reasoning モデルとして扱われる。エージェントの thinkingLevel が `"off"`（デフォルト）のとき `chat_template_kwargs.enable_thinking: false` がリクエストに付与される。llama.cpp 側で Qwen3 の thinking が抑制され、タイムアウトを防げる。

> **前提**: `"qwen-chat-template"` が機能するには、llama.cpp サーバーを **`--jinja` フラグ付き**で起動する必要がある。`--jinja` がない場合 `chat_template_kwargs` は無視され、thinking が常に ON になってタイムアウトする。
>
> ```bash
> llama-server -m /path/to/model.gguf --host 0.0.0.0 --port 8080 --jinja
> ```
>
> **Qwen3.5 の既知バグ**: `enable_thinking: false` を送っても thinking が止まらないケースが報告されている（[llama.cpp #20409](https://github.com/ggml-org/llama.cpp/issues/20409)）。その場合は `--reasoning-budget 0` を追加することで thinking トークン予算をゼロに固定できる。
>
> ```bash
> llama-server -m /path/to/Qwen3.5.gguf --host 0.0.0.0 --port 8080 --jinja --reasoning-budget 0
> ```

> **背景**: llama.cpp は Qwen3 のチャットテンプレートに従い、API リクエストに `chat_template_kwargs.enable_thinking` が含まれない場合は自動で thinking を有効にする構成がある。`thinkingFormat` を明示しないと thinking トークンが出力予算を消費してタイムアウトしやすい。

## thinkingLevel の制御（config/groups.json の groups[] 側）

`compat.thinkingFormat` はプロバイダーが thinking をどう受け付けるかを定義する。**thinking を実際に ON にするかどうか** はグループごとの設定（`config/groups.json` の `groups[].model.thinkingLevel`）で行う。

```json
{
  "model": {
    "provider": "llama-cpp",
    "modelId": "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
    "thinkingLevel": "low"
  }
}
```

**`thinkingLevel` に指定できる値**:

| 値 | `enable_thinking` | thinking トークン予算 |
|---|---|---|
| `"off"`（デフォルト） | `false` | 0（thinking しない） |
| `"minimal"` | `true` | 1,024 トークン |
| `"low"` | `true` | 2,048 トークン |
| `"medium"` | `true` | 8,192 トークン |
| `"high"` | `true` | 16,384 トークン |
| `"xhigh"` | `true` | モデルの `thinkingLevelMap` に依存 |

> **前提**: `thinkingLevel` を `"off"` 以外にするには、対応するプロバイダーの `config/credentials.json` で `compat.thinkingFormat` が `"qwen-chat-template"` や `"openrouter"` 等の thinking 制御に対応した値である必要がある。

**thinking を完全に OFF にする**（`compat.thinkingFormat` が必須）:

```json
{ "model": { "provider": "llama-cpp", "modelId": "Qwen3.6-35B-...", "thinkingLevel": "off" } }
```

`thinkingLevel: "off"` はデフォルト値なので省略可能。ただし `config/credentials.json` の `compat.thinkingFormat` を設定していない場合、thinking OFF のフィールドはリクエストに含まれず、ローカル推論サーバー側のデフォルトに従う。

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

> **プロバイダー名の使い分け**: `provider` の値は任意の文字列を指定できる。`"llama-cpp"` は単なる識別子で、`config/groups.json` の `groups[].model.provider` と一致させれば何でもよい。thinking 制御が不要なモデル用と Qwen3 系モデル用を別エントリとして分けておくと管理しやすい（例: `"llama-cpp"` と `"llama-cpp-qwen3"`）。

API Key 不要、最小構成:

```json
{
  "provider": "llama-cpp",
  "baseUrl": "http://localhost:8080/v1",
  "api": "openai-completions"
}
```

### カスタムプロバイダー（Qwen3 thinking 制御あり）

```json
{
  "provider": "llama-cpp",
  "baseUrl": "http://192.168.1.50:8080/v1",
  "api": "openai-completions",
  "contextWindow": 65536,
  "maxTokens": 4096,
  "compat": { "thinkingFormat": "qwen-chat-template" }
}
```

`compat.thinkingFormat: "qwen-chat-template"` を設定することで、`thinkingLevel` の値に応じて `chat_template_kwargs.enable_thinking` がリクエストに付与されるようになる。**設定しない場合は thinking OFF のフィールド自体が送られず、llama.cpp がデフォルト（thinking ON）で動作する。**

| thinkingLevel | chat_template_kwargs.enable_thinking |
|---|---|
| `"off"`（デフォルト） | `false` を明示送信 |
| `"low"` 以上 | `true` を明示送信 |
| compat 未設定 | **送信しない**（サーバー任せ） |

### カスタムプロバイダー（Ollama + Qwen3 thinking 制御あり）

```json
{
  "provider": "ollama",
  "baseUrl": "http://192.168.1.50:11434/v1",
  "api": "openai-completions",
  "contextWindow": 65536,
  "maxTokens": 4096,
  "compat": {
    "thinkingFormat": "openrouter",
    "thinkingLevelMap": { "off": "none", "minimal": "low", "xhigh": "high" }
  }
}
```

Ollama の OpenAI 互換 API は `reasoning.effort` 形式を使うため `thinkingFormat: "openrouter"` を指定する。`thinkingLevel: "off"` が `reasoning.effort: "none"` として送信されるように、`thinkingLevelMap` で明示的にマッピングする。

> **前提**: Ollama **v0.9.0 以降**が必要（thinking サポートが v0.9.0 で追加）。llama.cpp の `--jinja` のような特別な起動フラグは不要。

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

### モデル単位の入力モダリティ（`models[modelId].input`）

カスタムプロバイダーの `models` フィールドで、`modelId` ごとに受け付ける入力モダリティを指定できる。省略時は `["text"]`（テキスト入力のみ）。

`read` ツールが画像ファイル（png/jpg/gif/webp）を読み込むと `type: "image"` のコンテンツブロックを返すが、`pi-ai` の `openai-completions` プロバイダーは `model.input` に `"image"` が含まれていない場合、その画像を `"(see attached image)"` というテキストに差し替えて送信する。同じ llama.cpp サーバーでも modelId によって vision 対応（mmproj）の有無が異なるため、vision 対応モデルにのみ `input: ["text", "image"]` を指定する。

```json
{
  "provider": "llama-cpp",
  "baseUrl": "http://localhost:8080/v1",
  "api": "openai-completions",
  "models": {
    "qwen3-vl": { "input": ["text", "image"] }
  }
}
```

### 将来的な拡張

以下は現在の実装では未対応ですが、設計上の検討事項です：

- **OneCLI への移行**: 外部ゲートウェイを経由したより安全なシークレット管理
- **グループごとのシークレット制御**: `groups/{name}/` 以下にプロバイダー設定を持つ
- **MCP サーバー用プロキシ**: ツール側の外部サービス接続にも同様の仕組みを適用
