# Codex OAuth を CLIProxyAPI 経由で使う

ChatGPT/Codex OAuthのtoken・account ID・backend API追従はアプリ本体に入れず、[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)へ閉じ込める。AstraではCLIProxyAPIをホストで動かす構成を推奨し、検証済みversionは **v7.2.155** とする。

```text
sandbox agent
  -> credential-proxy-server (this app)
     -> http://localhost:8317/v1/responses
        -> CLIProxyAPI
           -> chatgpt.com/backend-api/codex/responses
```

sandbox containerからCLIProxyAPIへ直接接続させない。

## 責務分担

- my-discord-agent: OpenAI Responsesリクエスト、Discord session、Pi Agent loop、tool実行、model選択
- Credential Proxy: CLIProxyAPIのURLとlocal API keyをsandboxから隠し、upstreamへ転送
- CLIProxyAPI: Codex OAuth login、token refresh、account ID、Codex backendとのprotocol変換

## CLIProxyAPI v7.2.155のインストール

[release v7.2.155](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.155)からOS / architectureに合うarchiveを取得し、含まれるbinaryをPATH上へ配置する。GitHub CLIを使う場合はasset名を確認してから選ぶ。

```bash
gh release view v7.2.155 --repo router-for-me/CLIProxyAPI
gh release download v7.2.155 --repo router-for-me/CLIProxyAPI --pattern '<OS/architectureに合うasset名>'
cli-proxy-api --help 2>&1 | head -1
```

先頭行が`CLIProxyAPI Version: 7.2.155`であることを確認する。package managerの最新版を検証済みversionとして扱わない。

## config.yaml の設定

設定ファイルは`~/.cli-proxy-api/config.yaml`に固定する。

```yaml
host: "127.0.0.1"
port: 8317

api-keys:
  - "your-local-cliproxy-key"
```

`api-keys`の値をmy-discord-agentの`.env`にも設定する。

```env
CLIPROXY_API_KEY=your-local-cliproxy-key
```

## Codex OAuth loginと起動

ブラウザを使えるhostでは次を実行する。

```bash
cli-proxy-api -config "$HOME/.cli-proxy-api/config.yaml" -codex-login
```

headless環境ではdevice flowを使う。

```bash
cli-proxy-api -config "$HOME/.cli-proxy-api/config.yaml" -codex-device-login
```

loginと同じ設定ファイルでserverを起動する。

```bash
cli-proxy-api -config "$HOME/.cli-proxy-api/config.yaml"
```

ログにauth entryが読み込まれたことを確認する。OAuth tokenをログ、backup、Issueへ出力しない。

### Dockerを使う既存構成

Docker利用時もimageを検証済みtagまたはdigestへ固定し、OAuth dataを永続化する。Astraの検証済み手順は上記host運用であり、新規構成で`latest`を使わない。

## my-discord-agentの設定

`config/credentials.json`ではPi built-inのmodel identity / metadataを維持し、wire APIだけをCLIProxyAPI向けに変更する。custom metadataは定義しない。

```json
{
  "provider": "openai-codex",
  "envVars": ["CLIPROXY_API_KEY"],
  "baseUrl": "http://localhost:8317/v1",
  "api": "openai-responses"
}
```

`config/providers.json`では並列実行を許可できる。

```json
{ "provider": "openai-codex", "concurrency": "parallel" }
```

`config/groups.json`のmodel指定例:

```json
{
  "model": {
    "provider": "openai-codex",
    "modelId": "gpt-6-astra",
    "thinkingLevel": "max"
  }
}
```

`openai-codex`がmodel identity、`openai-responses`がwire API、CLIProxyAPIがgatewayである。`openai-codex-responses`はChatGPT OAuthを直接扱うadapterなので、この構成では使わない。Credential Proxyが`Authorization: Bearer $CLIPROXY_API_KEY`を注入し、sandboxへAPI keyやOAuth tokenを渡さない。

OpenAI API key経路は`provider: "openai"`と`OPENAI_API_KEY`で設定可能だが、Issue #404では有料smokeを行わない。

## 接続先

Credential Proxyをhost processとして起動する標準構成では次を使う。

```json
"baseUrl": "http://localhost:8317/v1"
```

Credential Proxy自体がCLIProxyAPIと同じDocker network内にいる既存構成だけ、Docker service名を使える。

```json
"baseUrl": "http://cli-proxy-api:8317/v1"
```

host processからDocker内部DNS名を使わない。

## フェイルクローズ

`CLIPROXY_API_KEY`が未設定の場合、sandbox向けcredentialから`openai-codex`は除外される。CLIProxyAPI停止・401・429・timeout時もOpenAI APIへ自動fallbackしない。

## Agent loop smoke

直接`curl`が成功するだけでは完了としない。gitignoredの実設定を上記へ変更してmy-discord-agentをこのworktreeから起動し、Discord Webから実経路 `Agent loop → Credential Proxy → CLIProxyAPI → Codex backend` を確認する。

1. `pwd`、`git rev-parse HEAD`、`cli-proxy-api --help 2>&1 | head -1`を記録する。
2. 対象groupで`openai-codex / gpt-6-astra / max`と`bash` toolを有効にする。
3. 「`ASTRA_SMOKE_OK` とだけ返してください」でbasic responseとSSE完了を確認する。
4. 「bashツールで `printf ASTRA_TOOL_OK` を実行し、その出力をそのまま返してください」でtool result後の継続推論を確認する。
5. logで`/v1/responses`、model identity、thinking level、到達可能なbaseUrlを確認する。`ChatGPT-Account-Id`生成、JWT decode、OpenAI API fallbackがないことも確認する。
6. Issue #404へ実施日、commit、CLIProxyAPI version、model設定、basic response / SSE / tool continuation / baseUrl到達性の成否だけをコメントする。秘密値は含めない。

smoke後は必要に応じてgitignoredの実設定を通常運用へ戻す。
