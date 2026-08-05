# Codex OAuth を CLIProxyAPI サイドカー経由で使う

ChatGPT/Codex OAuth の access token / refresh token / account ID / backend API 追従はアプリ本体に入れず、[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) をローカルサイドカーとして使う。

```text
sandbox agent
  -> credential-proxy-server (this app)
     -> http://localhost:8317/v1/responses
        -> CLIProxyAPI
           -> chatgpt.com/backend-api/codex/responses
```

## 責務分担

- my-discord-agent
  - OpenAI互換 Responses リクエスト生成
  - Discord セッション、Pi エージェントループ、ツール実行
  - provider / model の選択
- credential-proxy-server
  - CLIProxyAPI の URL とローカル API キーをサンドボックスから隠す
  - timeout と upstream error のマッピング
  - Codex OAuth token は保持しない
- CLIProxyAPI
  - ChatGPT/Codex OAuth login
  - access token refresh / refresh token rotation
  - account ID 管理
  - Codex backend と OpenAI Responses API の変換

## CLIProxyAPI 側

### インストール

**Arch Linux (AUR)**:
```bash
yay -S cli-proxy-api-bin
systemctl --user start cli-proxy-api
```

**Linux（ワンクリックインストーラー）**:
```bash
curl -fsSL https://raw.githubusercontent.com/router-for-me/cliproxyapi-installer/refs/heads/master/cliproxyapi-installer | bash
```

**macOS**:
```bash
brew install cliproxyapi
brew services start cliproxyapi
```

**Docker**:
```bash
docker run --rm -p 127.0.0.1:8317:8317 \
  -v /path/to/config.yaml:/CLIProxyAPI/config.yaml \
  eceasy/cli-proxy-api:latest
```

Docker イメージは `latest` ではなく、検証済みタグまたは digest に固定する。

### config.yaml の設定

`config.example.yaml` をコピーして `config.yaml` を作成する（設定ファイルパスは `~/.cli-proxy-api/config.yaml`）。

**基本設定**:
```yaml
host: "127.0.0.1"   # loopback のみ受け付ける
port: 8317

api-keys:
  - "your-local-cliproxy-key"   # このアプリの .env の CLIPROXY_API_KEY と合わせる
```

**Codex OAuth 設定**:
```yaml
oauth-model-alias:
  codex:
    - name: "gpt-5-codex"
      alias: "gpt-5-codex"

oauth-excluded-models:
  codex: []

codex-header-defaults:
  user-agent: "codex_cli_rs/0.114.0"
  beta-features: "multi_agent"
```

### ChatGPT へのログイン

サービスを止めてからログインし、完了後に再起動する。

```bash
systemctl --user stop cli-proxy-api
cli-proxy-api -codex-login          # ブラウザが開くので ChatGPT にログイン
systemctl --user start cli-proxy-api
```

ブラウザが使えないヘッドレス環境では `-codex-device-login`（デバイスコードフロー）を使う：

```bash
cli-proxy-api -codex-device-login
```

ログイン成功後、次回起動時のログに `1 auth entries` と表示されれば認証済み：

```
server clients and configuration updated: 1 clients (1 auth entries + ...)
```

ログイン後、OAuth 資格情報ディレクトリは CLIProxyAPI 専用 volume または設定ディレクトリに永続化される。volume・ログ・バックアップへ access token / refresh token を出力しない。

### Docker Compose での起動

アプリをホストで起動する標準構成では、CLIProxyAPI のポートを loopback にだけ公開する。

```yaml
services:
  cli-proxy-api:
    image: eceasy/cli-proxy-api:v1.x.x   # latest は固定タグに置き換える
    ports:
      - "127.0.0.1:8317:8317"
    volumes:
      - ./config.yaml:/CLIProxyAPI/config.yaml
      - cliproxy-data:/CLIProxyAPI/data
volumes:
  cliproxy-data:
```

### .env への API キー設定

CLIProxyAPI の `api-keys` に設定した値を、このアプリの `.env` に書く。

```env
CLIPROXY_API_KEY=your-local-cliproxy-key
```

## my-discord-agent 側

`config/credentials.json` に OpenAI互換 Responses provider として追加する。

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

`openai-responses` は API キーを通常の Bearer credential として扱い、`/v1/responses` を呼び出す。`openai-codex-responses` は ChatGPT OAuth credential と Codex backend を直接扱うアダプターなので、このサイドカー構成には使用しない。

アプリ本体（`credential-proxy-server` を含む）も CLIProxyAPI と同じ Docker ネットワーク内で起動する構成に限り、`baseUrl` に Docker のサービス名を使用できる。

```json
"baseUrl": "http://cli-proxy-api:8317/v1"
```

ホスト上でアプリを起動する場合、Docker 内部 DNS 名は解決できないため、loopback に公開した `http://localhost:8317/v1` を使用する。

`config/groups.json` のモデル指定例:

```json
{
  "model": {
    "provider": "codex-oauth",
    "modelId": "gpt-5-codex"
  }
}
```

`credential-proxy-server` が `Authorization: Bearer $CLIPROXY_API_KEY` を CLIProxyAPI へ注入するため、サンドボックスコンテナには CLIProxyAPI の API キーも OAuth token も渡らない。

## フェイルクローズ

`CLIPROXY_API_KEY` が未設定の場合、サンドボックスへ渡す credential から `codex-oauth` provider は除外される。CLIProxyAPI 停止・401・429・timeout 時も、別の API キー課金経路へ自動フォールバックしない。課金経路へ切り替える場合は `config/groups.json` の provider を明示的に変更する。

## スモークテスト

更新時は少なくとも以下を確認する。

- 非ストリーミング `/v1/responses`
- SSE ストリーミング完了
- tool call / tool result の往復
- 期限切れ access token からの自動 refresh
- 401、429、upstream timeout のマッピング
- usage 情報の有無

例（CLIProxyAPI へ直接）:

```bash
curl -sS http://localhost:8317/v1/responses \
  -H "Authorization: Bearer $CLIPROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5-codex","input":"ping"}'
```
