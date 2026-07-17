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
  ├─ config/credentials.json           # プロバイダ→envVar→baseUrl マッピング
  └─ src/proxy/credential-proxy-server.ts  # ホスト側 HTTP リバースプロキシ
       ├─ Authorization ヘッダを注入して upstream へ転送
       └─ src/agent/manager.ts         # CREDENTIAL_PROXY_JSON 環境変数でコンテナに渡す
            └─ Docker コンテナ
                 └─ @earendil-works/pi-ai
```

コンテナには実際の API キーではなく、プロキシ URL（`http://host.docker.internal:{port}/{provider}`）を `CREDENTIAL_PROXY_JSON` 環境変数として渡す。実キーはホストプロセスのメモリにのみ存在する。

### config/credentials.json

`config/credentials.example.json` をコピーして `config/credentials.json` を作成する。トップレベルは配列。

デフォルトで有効なプロバイダ（動作確認済み）：

```json
[
  { "provider": "openai",      "envVars": ["OPENAI_API_KEY"],     "baseUrl": "https://api.openai.com/v1" },
  { "provider": "anthropic",   "envVars": ["ANTHROPIC_API_KEY"],  "baseUrl": "https://api.anthropic.com" },
  { "provider": "deepseek",    "envVars": ["DEEPSEEK_API_KEY"],   "baseUrl": "https://api.deepseek.com" },
  { "provider": "google",      "envVars": ["GEMINI_API_KEY"],     "baseUrl": "https://generativelanguage.googleapis.com/v1beta" },
  { "provider": "groq",        "envVars": ["GROQ_API_KEY"],       "baseUrl": "https://api.groq.com/openai/v1" },
  { "provider": "openrouter",  "envVars": ["OPENROUTER_API_KEY"], "baseUrl": "https://openrouter.ai/api/v1" },
  { "provider": "opencode-go", "envVars": ["OPENCODE_API_KEY"],   "baseUrl": "https://opencode.ai/zen/go/v1" }
]
```

**重要な挙動**:
- `envVars` リスト内で `process.env` に設定されている**すべて**が secret として注入される。
- **警告ログ**: 1つも設定されていないプロバイダは静かにスキップされる。一部だけ設定されている場合は「一部の環境変数が未設定です」と警告が出る（複数変数が必要なプロバイダで不足を検出するため）。
- 同じ環境変数が複数の provider に含まれている場合、**各 provider ごとに独立して注入される**。
- `baseUrl` に `{ENV_VAR}` 形式のプレースホルダが含まれている場合、`process.env` の値で動的に置換される。**置換できない場合は env vars の注入も含めてその provider を完全にスキップする**（`AZURE_OPENAI_API_KEY` は設定済みでも `AZURE_OPENAI_BASE_URL` が未設定なら注入されない）。
- `auth` を省略した場合、`envVars` の値は `Authorization: Bearer ...` として注入される。Browserless のように query parameter が必要な API は `auth: { "type": "query-token", "queryParam": "token" }` を指定する。

### Google OAuth（Google Calendar 等）

`graph`（MSAL）と同様に、`google` フィールドを指定したプロバイダーは OAuth トークンが `Authorization: Bearer ...` として自動注入される。

```json
{
  "provider": "google-calendar",
  "baseUrl": "https://www.googleapis.com/calendar/v3",
  "google": {
    "clientId": "xxxxx.apps.googleusercontent.com",
    "clientSecretEnvVar": "GOOGLE_CALENDAR_CLIENT_SECRET",
    "scopes": ["https://www.googleapis.com/auth/calendar"]
  }
}
```

Google Cloud Console での OAuth クライアント作成手順（OAuth 同意画面のテストユーザー登録を含む）は [`docs/google-cloud-oauth-setup.md`](./google-cloud-oauth-setup.md) を参照。

**重要な挙動**:
- `clientSecretEnvVar` が指す環境変数が未設定の場合、そのプロバイダーの Google Auth 初期化はスキップされ、警告ログが出る（リクエストは 502 になる）。
- 初回利用時は OAuth デバイスフローが起動し、表示される URL とコードでブラウザ認証を行う。取得したリフレッシュトークンは `data/google-token-{provider}.json`（0600）に保存され、以後はサイレント更新される。
- デバイスフローは `initCredentialProxyServer()`（ホスト起動時）で一度トリガーされる。これにより、Discordからの最初のカレンダー操作リクエストでデバイスフロー（最大30分）がブロックすることを避けている。認証に失敗・タイムアウトした場合はエラーログを出すのみで、ホストの起動自体は継続する（以後のカレンダー系ツール呼び出しは502になる）。
- `msal` と同様、`google` フィールドはサンドボックスコンテナに渡る `CREDENTIAL_PROXY_JSON` には含まれない（ホスト側のみで使用）。

### Reddit クッキー認証（agent-reach の reddit サービス用）

Reddit は OAuth (`client_credentials`) の新規アプリ申請を2025年11月のポリシー改定以降事実上ブロックしているため（詳細は [`docs/reddit-oauth-setup.md`](./reddit-oauth-setup.md)）、ログイン済みブラウザの永続プロファイルから定期的に抽出したクッキーで `www.reddit.com` にアクセスする。

初回ログイン手順・定期延命の仕組みは [`docs/reddit-cookie-setup.md`](./reddit-cookie-setup.md) を参照。

```json
{
  "provider": "reddit",
  "baseUrl": "https://www.reddit.com",
  "redditCookie": {
    "cookieFile": "data/reddit-cookies.json",
    "maxAgeDays": 7
  }
}
```

- `pnpm reddit:login` で初回ログイン（Playwright永続プロファイル: `data/reddit-browser-profile/`）。以後は `cron`(`jobs/reddit-cookie-refresh.ts`)が定期的にセッション延命＋クッキー再抽出を行う。
- `cookieFile` の内容が `maxAgeDays`(デフォルト7日)より古い場合、そのプロバイダーへのリクエストは 502 になる。
- `redditCookie` フィールドは `msal` / `google` と同様、サンドボックスコンテナに渡る `CREDENTIAL_PROXY_JSON` には含まれない（ホスト側のみで使用）。
- `agent-reach` ツールのredditサービス、互換用`agent-reach.sh`、および`last30days`スキル（`scripts/reddit-search.sh`）は`CREDENTIAL_PROXY_JSON`からプロキシURLを解決してアクセスする。

### GitHub Clone（`clone-repository` ツール用）

エージェントが README 以外も参照したい場合に、リポジトリを `/workspace` 配下へ shallow clone する。git の smart HTTP プロトコルは通常の HTTP リクエスト/レスポンスなので、既存の汎用リバースプロキシがそのまま使えるが、**認証方式は `api.github.com`（REST API）とは異なる**点に注意。

```json
{
  "provider": "github-git",
  "envVars": ["GITHUB_CLONE_TOKEN"],
  "baseUrl": "https://github.com",
  "auth": { "type": "basic", "username": "x-access-token" }
}
```

- `list-issues`/`read-issue`/`comment-issue` が使う `github`（`api.github.com` 向け、Issues権限のみ）とは別のプロバイダー・別のトークンに分離している。Issue 操作用トークンに Contents 権限を持たせない（最小権限）ため。
- `GITHUB_CLONE_TOKEN` は対象リポジトリ・`Contents: Read` 権限のみの fine-grained PAT を想定。
- **`auth: { "type": "basic" }` が必須**: GitHub の git smart-HTTP サーバー（`github.com`、`api.github.com` とは別エンドポイント）は `Authorization: Bearer ...` を受け付けず、`Authorization: Basic base64("x-access-token:<token>")` が必要（`actions/checkout` 等と同じ方式）。`auth` を省略すると Bearer ヘッダーが注入され、プライベートリポジトリの clone が 401 で失敗する。パブリックリポジトリは無認証でも clone 自体は成立するため、トークンが実際には使われていないことに気づきにくい点に注意。
- `clone-repository` ツールはトークンを直接受け取らず、`resolveProxyBaseUrl("github-git")` で得たプロキシURL（`http://host.docker.internal:{port}/github-git/{owner}/{repo}.git`）に対して `git clone --depth 1` を実行する。実トークンはホストプロセスのメモリにのみ存在し、エージェント・コンテナ内には渡らない。

### その他の pi-ai 対応プロバイダ

以下のプロバイダも pi-ai では対応しているが、現状未検証・未使用のため `credentials.example.json` からは除外している。必要な env var を `.env` に設定し、`config/credentials.json` に provider エントリを手動で追加すれば利用可能（`envVars` に設定した変数のうち `process.env` にあるものが secret として注入される。`baseUrl` は各プロバイダの公式エンドポイントを指定）：

| プロバイダ | pi-ai 識別子 | 環境変数 |
| --- | --- | --- |
| Azure OpenAI | `azure-openai-responses` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_RESOURCE_NAME`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` |
| Google Vertex AI | `google-vertex` | `GOOGLE_CLOUD_API_KEY`, `GOOGLE_CLOUD_PROJECT`, `GCLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS` |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` |
| xAI | `xai` | `XAI_API_KEY` |
| Mistral | `mistral` | `MISTRAL_API_KEY` |
| Cloudflare Workers AI / AI Gateway | `cloudflare` | `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID` |
| MiniMax | `minimax` | `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY` |
| Moonshot AI | `moonshot` | `MOONSHOT_API_KEY` |
| Kimi For Coding | `kimi-for-coding` | `KIMI_API_KEY` |
| Fireworks | `fireworks` | `FIREWORKS_API_KEY` |
| Hugging Face | `huggingface` | `HF_TOKEN` |
| Xiaomi MiMo | `xiaomi` | `XIAOMI_API_KEY`, `XIAOMI_TOKEN_PLAN_CN_API_KEY`, `XIAOMI_TOKEN_PLAN_AMS_API_KEY`, `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `copilot` | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` |
| Amazon Bedrock | `amazon-bedrock` | `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_REGION` |
| Vercel AI Gateway | `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` |

### カスタムプロバイダー

`pi-ai` の組み込みプロバイダー以外（ローカルの llama-cpp サーバーなど）も `config/credentials.json` に定義可能。

```json
{
  "provider": "llama-cpp",
  "baseUrl": "http://localhost:8080/v1",
  "api": "openai-completions"
}
```

- `provider` は自由な名前を指定可能。`config/groups.json` の `groups[].model.provider` に同じ名前を設定する。
- `api` はオプション。未指定時のデフォルトは `"openai-completions"`。他に `"openai-responses"`、`"openai-codex-responses"`、`"anthropic-messages"` 等が指定可能。
- `envVars` はオプション。省略または空配列の場合、secret 注入は行われず baseUrl の解決と allowHost の登録のみ行う。これは API Key が不要なローカルサーバーに便利。
- カスタムプロバイダーの場合、モデルIDの検証は行われず、任意の文字列を `modelId` に指定できる。

### CLIProxyAPI / Codex OAuth

ChatGPT/Codex OAuth はアプリ本体で扱わず、CLIProxyAPI をローカルサイドカーとして使う。`config/credentials.json` には OpenAI Responses 互換 provider として登録する。

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

詳細な運用条件とスモークテストは `docs/codex-oauth-cliproxyapi.md` を参照。

### 将来的な拡張

- OneCLI への移行
- グループごとに異なるシークレットセットを制御
- MCP サーバー用のプロキシ対応
