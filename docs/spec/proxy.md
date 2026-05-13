# プロキシサーバー（クレデンシャル安全挿入）

`src/agent/manager.ts` の `sendMessage()` 内で microsandbox の `secret()` を使って実装。

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
  ├─ .env                        # 環境変数（ホスト側で読み込み）
  ├─ config/credential-proxy.json # プロバイダ→envVar→baseUrl マッピング
  └─ src/agent/manager.ts         # 環境変数読み込み → sandbox.secret() 注入
       └─ microsandbox VM        # TSI ネットワーク層でヘッダ差し替え
            └─ @earendil-works/pi-ai
```

### credential-proxy.json

`config/credential-proxy.example.json` をコピーして `config/credential-proxy.json` を作成する。

デフォルトで有効なプロバイダ（動作確認済み）：

```json
[
  { "provider": "openai",           "envVars": ["OPENAI_API_KEY"],          "baseUrl": "https://api.openai.com/v1" },
  { "provider": "anthropic",        "envVars": ["ANTHROPIC_API_KEY"],       "baseUrl": "https://api.anthropic.com" },
  { "provider": "deepseek",         "envVars": ["DEEPSEEK_API_KEY"],        "baseUrl": "https://api.deepseek.com" },
  { "provider": "google",           "envVars": ["GEMINI_API_KEY"],          "baseUrl": "https://generativelanguage.googleapis.com/v1beta" },
  { "provider": "groq",             "envVars": ["GROQ_API_KEY"],            "baseUrl": "https://api.groq.com/openai/v1" },
  { "provider": "openrouter",       "envVars": ["OPENROUTER_API_KEY"],      "baseUrl": "https://openrouter.ai/api/v1" },
  { "provider": "opencode-go",      "envVars": ["OPENCODE_API_KEY"],        "baseUrl": "https://opencode.ai/zen/go/v1" }
]
```

**重要な挙動**:
- `envVars` リスト内で `process.env` に設定されている**すべて**が secret として注入される。
- **警告ログ**: 1つも設定されていないプロバイダは静かにスキップされる。一部だけ設定されている場合は「一部の環境変数が未設定です」と警告が出る（複数変数が必要なプロバイダで不足を検出するため）。
- 同じ環境変数が複数の provider に含まれている場合、**各 provider ごとに独立して注入される**。
- `baseUrl` に `{ENV_VAR}` 形式のプレースホルダが含まれている場合、`process.env` の値で動的に置換される。置換できない場合はその provider をスキップ。

### その他の pi-ai 対応プロバイダ

以下のプロバイダも pi-ai では対応しているが、現状未検証・未使用のため `credential-proxy.example.json` からは除外している。必要に応じて手動で追加可能：

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

### 将来的な拡張

- OneCLI への移行
- グループごとに異なるシークレットセットを制御
- MCP サーバー用のプロキシ対応
