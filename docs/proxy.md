# プロキシサーバー（クレデンシャル安全挿入）

## 目的

エージェントが使う外部 API へのリクエストを中継し、APIキー等のシークレットをエージェントに直接渡さずに注入する。

## nanoclaw の実装（OneCLI）

> 参考: `docs/clone/nanoclaw/src/container-runner.ts`（OneCLI ensureAgent）
> 参考: `docs/clone/nanoclaw/CLAUDE.md` の Secrets / Credentials / OneCLI セクション

nanoclaw は **OneCLI**（`@onecli-sh/sdk`）という外部ゲートウェイを使用。

```
Agent container → OneCLI proxy（シークレット注入） → 外部API
```

- シークレットはOneCLIのVaultで管理。コンテナ側は値を知らない
- エージェントグループごとに「どのシークレットを使えるか」を制御（`selective` / `all` モード）
- 承認フロー：クレデンシャルを使うアクションにオーナー承認を要求できる

## 本プロジェクトの実装

### 構成

```
Host
  ├─ .env                              # 環境変数（ホスト側で読み込み）
  ├─ config/config.json                # credentials セクションにプロバイダ→envVar→baseUrl マッピング
  └─ src/proxy/credential-proxy-server.ts  # ホスト側 HTTP リバースプロキシ
       ├─ Authorization ヘッダを注入して upstream へ転送
       └─ src/agent/manager.ts         # CREDENTIAL_PROXY_JSON 環境変数でコンテナに渡す
            └─ Docker コンテナ
                 └─ @earendil-works/pi-ai
```

コンテナには実際の API キーではなく、プロキシ URL（`http://host.docker.internal:{port}/{provider}`）を `CREDENTIAL_PROXY_JSON` 環境変数として渡す。実キーはホストプロセスのメモリにのみ存在する。

### config/config.json の credentials セクション

`config/config.example.json` をコピーして `config/config.json` を作成する。

デフォルトで有効なプロバイダ（動作確認済み）：

```json
{
  "credentials": [
    { "provider": "openai",      "envVars": ["OPENAI_API_KEY"],     "baseUrl": "https://api.openai.com/v1" },
    { "provider": "anthropic",   "envVars": ["ANTHROPIC_API_KEY"],  "baseUrl": "https://api.anthropic.com" },
    { "provider": "deepseek",    "envVars": ["DEEPSEEK_API_KEY"],   "baseUrl": "https://api.deepseek.com" },
    { "provider": "google",      "envVars": ["GEMINI_API_KEY"],     "baseUrl": "https://generativelanguage.googleapis.com/v1beta" },
    { "provider": "groq",        "envVars": ["GROQ_API_KEY"],       "baseUrl": "https://api.groq.com/openai/v1" },
    { "provider": "openrouter",  "envVars": ["OPENROUTER_API_KEY"], "baseUrl": "https://openrouter.ai/api/v1" },
    { "provider": "opencode-go", "envVars": ["OPENCODE_API_KEY"],   "baseUrl": "https://opencode.ai/zen/go/v1" }
  ],
  "groups": [],
  "cron": []
}
```

**重要な挙動**:
- `envVars` リスト内で `process.env` に設定されている**すべて**が secret として注入される。
- **警告ログ**: 1つも設定されていないプロバイダは静かにスキップされる。一部だけ設定されている場合は「一部の環境変数が未設定です」と警告が出る（複数変数が必要なプロバイダで不足を検出するため）。
- 同じ環境変数が複数の provider に含まれている場合、**各 provider ごとに独立して注入される**。
- `baseUrl` に `{ENV_VAR}` 形式のプレースホルダが含まれている場合、`process.env` の値で動的に置換される。**置換できない場合は env vars の注入も含めてその provider を完全にスキップする**（`AZURE_OPENAI_API_KEY` は設定済みでも `AZURE_OPENAI_BASE_URL` が未設定なら注入されない）。
- `auth` を省略した場合、`envVars` の値は `Authorization: Bearer ...` として注入される。Browserless のように query parameter が必要な API は `auth: { "type": "query-token", "queryParam": "token" }` を指定する。

### その他の pi-ai 対応プロバイダ

以下のプロバイダも pi-ai では対応しているが、現状未検証・未使用のため `config.example.json` からは除外している。必要に応じて手動で追加可能：

- Azure OpenAI (`azure-openai-responses`)
- Google Vertex AI (`google-vertex`)
- Cerebras, xAI, Mistral
- Cloudflare Workers AI / AI Gateway
- MiniMax, Moonshot AI, zAI
- Fireworks, Hugging Face
- Xiaomi MiMo
- GitHub Copilot, Amazon Bedrock
- Vercel AI Gateway

`.env.example` には上記を含む全プロバイダの環境変数がコメント付きで記載されている。

### カスタムプロバイダー

`pi-ai` の組み込みプロバイダー以外（ローカルの llama-cpp サーバーなど）も `config/config.json` の `credentials` に定義可能。

```json
{
  "provider": "llama-cpp",
  "baseUrl": "http://localhost:8080/v1",
  "api": "openai-completions"
}
```

- `provider` は自由な名前を指定可能。`group.json` の `model.provider` に同じ名前を設定する。
- `api` はオプション。未指定時のデフォルトは `"openai-completions"`。他に `"openai-responses"` や `"anthropic-messages"` 等が指定可能。
- `envVars` はオプション。省略または空配列の場合、secret 注入は行われず baseUrl の解決と allowHost の登録のみ行う。これは API Key が不要なローカルサーバーに便利。
- カスタムプロバイダーの場合、モデルIDの検証は行われず、任意の文字列を `modelId` に指定できる。

### 将来的な拡張

- OneCLI への移行
- グループごとに異なるシークレットセットを制御
- MCP サーバー用のプロキシ対応
