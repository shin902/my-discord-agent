# Credential ProxyとTool Proxyの認証境界

この文書は認証情報と実行経路の現行仕様です。設定フィールド・既定値は [Credential設定リファレンス](config/credential-proxy.md)、設定例は [credentials.example.json](../config/credentials.example.json) を正本とします。

## Credential forwarding

```text
Agent sandbox
  → Credential Proxyのprovider URL
  → ホストでupstream認証を付与
  → 設定された外部API
```

[manager](../src/agent/manager.ts) はsandbox向けの `CREDENTIAL_PROXY_JSON` を生成します。渡すのはproxy URLへ置換した `baseUrl` とモデル設定であり、`envVars`、`auth`、`msal`、`google`、`redditCookie` は除去します。実APIキーやOAuth tokenをsandboxの環境変数へ渡しません。

[Credential Proxy](../src/proxy/credential-proxy-server.ts) はホスト側で認証情報を解決します。`envVars` は複数secretの注入指定ではなく、先頭から最初の空でない値を選ぶ候補一覧です。認証形式と未設定時の挙動は [設定リファレンス](config/credential-proxy.md#envvarsと認証) を参照してください。

`forceCustom` はモデル解決の選択です。KnownProviderの組み込みモデル定義と、Credential Proxy用のカスタムモデル定義を区別します。詳細は [モデル解決](config/credential-proxy.md#モデル解決) を参照してください。

Credential forwardingにはTool Proxyのrun単位capability認可と同じ保証はありません。sandboxへのURL非公開だけをhost routeの認可とみなさないでください。ネットワーク境界の制約は [セキュリティ上のトレードオフ](security-tradeoffs.md) を参照してください。

## Tool Proxy

credential forwardingとは別に、host executorのcapabilityは専用RPC（`/__tool-proxy/rpc`）で実行します。天気、Tavily Search、arXiv、GitHub REST、Mail、Google Calendarがこの経路を使います。

```text
Agent sandbox
  → Tool Proxy（run token・capability・引数検証）
  → host executor / 専用Tool Runtime
  → 外部API
```

run開始時にhostメモリへ短命opaque token、run identity、effective config由来のcapability allowlist、approval対象集合、trusted Discord bot/channel、revoke signalをsnapshotとして登録し、終了時にrevokeします。

approval対象はvalidate後に確定したcanonical argsをsnapshotのDiscord destinationへ表示し、Approve後にauthorityを再確認して同じinvocationを実行します。approval専用TTLやgrant tokenは設けず、Discord updateの短いtimeout以外はrequesting runの生存中だけ待機します。Proxyはmethod/path、Content-Type、token、capability、引数schemaを検証し、未認可・不明・不正な要求を拒否します。

GitHub、Graph、Google Calendar、Tavilyのcredentialはhost側だけで解決します。managerは通常これらとRedditのforwarding定義をsandboxへ渡しません（同名providerが当該runのmodel providerの場合は除外対象外）。Tool Proxyの結果はrawで返し、長い出力の外部化はsandbox側の共通output boundaryが担当します。

実装は [Tool Proxy server](../src/proxy/tool-proxy-server.ts)、tool設定・approvalの仕様は [エージェントのツールとスキル](agent-tools-skills.md) を参照してください。

## OAuthと専用Runtime

- Microsoft GraphのMSAL設定、GoogleのOAuth設定・token取得はホスト側で管理します。手順は [Azure app登録](guides/azure-app-registration.md) と [Google OAuth設定](guides/google-cloud-oauth-setup.md) を参照してください。
- Google OAuthは起動時にtoken取得を試みます。認証が必要な場合は案内を出してバックグラウンドでdevice flowを進め、認証待ちのために起動をブロックしません。
- Redditのcanonical認証状態は `data/reddit-browser-profile/` と `data/reddit-cookies.json` です。専用Tool Runtimeへだけmountし、Agent sandboxへCookie・認証token・Runtime内のprivate pathを渡しません。`credentials.json` のReddit forwardingは使いません。[セットアップ](guides/reddit-cookie-setup.md) と [Tool Runtime仕様](spec/agent-reach-tool-runtime.md) を参照してください。
- CLIProxyAPIを使う構成では、ChatGPT/Codex OAuth tokenはsidecarが管理し、本アプリのCredential Proxyはsidecar用APIキーをホストで付与します。[構成手順](guides/codex-oauth-cliproxyapi.md) を参照してください。

本プロジェクトはOneCLIを使用していません。旧文書の他プロジェクト比較や将来構想は現行の設定・認可仕様ではありません。
