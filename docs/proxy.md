# Credential ProxyとTool Proxyの認証境界

この文書は認証情報と実行経路の現行仕様です。設定フィールド・既定値は [Credential設定リファレンス](config/credential-proxy.md)、設定例は [credentials.example.json](../config/credentials.example.json) を正本とします。

## Credential forwarding

```text
Agent sandbox
  → Credential Proxyのprovider URL
  → ホストでupstream認証を付与
  → 設定されたLLM API / CLIProxyAPI
```

[manager](../src/agent/manager.ts) はsandbox向けの `CREDENTIAL_PROXY_JSON` を生成します。渡すのはproxy URLへ置換した `baseUrl` とモデル設定であり、`envVars`、`auth`、`msal`、`google`、`redditCookie` は除去します。実APIキーやOAuth tokenをsandboxの環境変数へ渡しません。

[Credential Proxy](../src/proxy/credential-proxy-server.ts) は[LLMとして宣言された接続](config/credential-proxy.md#llm-routeの公開条件)だけをrouteとして公開し、ホスト側で認証情報を解決します。非LLM entryはsandbox向けJSONから隠すだけでなくHTTP forwarding対象からも除き、直接 `/github/...`、`/tavily/...`、`/google-calendar/...` 等を呼んでも404になります。`envVars` は複数secretの注入指定ではなく、先頭から最初の空でない値を選ぶ候補一覧です。認証形式と未設定時の挙動は [設定リファレンス](config/credential-proxy.md#envvarsと認証) を参照してください。

`forceCustom` はモデル解決の選択です。KnownProviderの組み込みモデル定義と、Credential Proxy用のカスタムモデル定義を区別します。詳細は [モデル解決](config/credential-proxy.md#モデル解決) を参照してください。

Agent sandbox の direct egress は host-gateway の必要な proxy TCP port に制限します。Credential Proxy の責務は secret confidentiality と credential injection / forwarding です。Agent が inference credential を利用すること自体は許可し、provider/model/path/method 単位の認可、inference run token、approval、独自 rate limit は追加しません。credential-backed operation の利用自体を制限する必要がある場合は、Tool Proxy capability へ移します。Tool Proxy は run-scoped authority、capability 認可、schema validation、必要時 approval を担当します。ネットワーク境界の制約は [セキュリティ上のトレードオフ](security-tradeoffs.md) を参照してください。

Codex subscription経路ではPiのmodel provider identity（`openai-codex`）を保ち、wire `api` を `openai-responses`、upstreamをCLIProxyAPIの `/v1` に設定できます。Proxyはlocal gateway keyの差し替えとrequest / responseの透過forwardだけを行います。JWT解析、account ID、OAuth refresh、Codex backend protocol変換、provider固有transport選択は実装しません。model metadataはPi、Codex固有処理はCLIProxyAPIが所有します。

LLM route間の利用制限はありません。旧PR #421のprovider-bound run token方式は採用せず、sandbox-facing surfaceをLLM用途へ縮小してTool Proxy迂回を閉じます。既存の `__agent/bot` scoped RPCは別の既存契約として維持し、LLM用の第二authorization planeは追加しません。

## Tool Proxy

credential forwardingとは別に、host/runtime executorのcapabilityは専用RPC（`/__tool-proxy/rpc`）で実行します。天気、Tavily Search、GitHub REST、Mail、Google Calendarに加え、agent-reach・arXiv・last30daysの取得がこの経路を使います。

```text
Agent sandbox
  → Tool Proxy（run token・capability・引数検証）
  → host executor / Tool callごとの使い捨てTool Runtime
  → 外部API
```

native ToolとSkill CLIは同じrun tokenを共有します。許可集合はeffective toolsと、trustedな組込Skill依存の和集合です。Skill本文から権限を取得せず、wildcardも組込依存だけへ展開します。

run開始時にhostメモリへ短命opaque token、run identity、effective config由来のcapability allowlist、approval対象集合、trusted Discord bot/channel、revoke signalをsnapshotとして登録し、終了時にrevokeします。

approval対象はvalidate後に確定したcanonical argsをsnapshotのDiscord destinationへ表示し、Approve後にauthorityを再確認して同じinvocationを実行します。approval専用TTLやgrant tokenは設けず、Discord updateの短いtimeout以外はrequesting runの生存中だけ待機します。Proxyはmethod/path、Content-Type、token、capability、引数schemaを検証し、未認可・不明・不正な要求を拒否します。

GitHub、Graph、Google Calendar、Tavilyのcredentialはhost側だけで解決します。これらとReddit等のintegration接続はCredential Proxyの公開surfaceに含めません。model providerとして選択しただけでintegration routeが公開される例外もありません。Tool Proxyの結果はrawで返し、長い出力の外部化はsandbox側の共通output boundaryが担当します。

実装は [Tool Proxy server](../src/proxy/tool-proxy-server.ts)、tool設定・approvalの仕様は [エージェントのツールとスキル](agent-tools-skills.md) を参照してください。

## OAuthとTool Runtime

- Microsoft GraphのMSAL設定、GoogleのOAuth設定・token取得はホスト側で管理します。手順は [Azure app登録](guides/azure-app-registration.md) と [Google OAuth設定](guides/google-cloud-oauth-setup.md) を参照してください。
- Google OAuthは起動時にtoken取得を試みます。認証が必要な場合は案内を出してバックグラウンドでdevice flowを進め、認証待ちのために起動をブロックしません。
- Redditのcanonical認証状態は `data/reddit-browser-profile/` と `data/reddit-cookies.json` です。必要なcallのTool Runtimeへだけmountし、Agent sandboxへCookie・認証token・Runtime内のprivate pathを渡しません。`credentials.json` のReddit forwardingは使いません。[セットアップ](guides/reddit-cookie-setup.md) と [Tool Runtime仕様](spec/tool-runtime.md) を参照してください。
- CLIProxyAPIを使う構成では、ChatGPT/Codex OAuth tokenはsidecarが管理し、本アプリのCredential Proxyはsidecar用APIキーをホストで付与します。[構成手順](guides/codex-oauth-cliproxyapi.md) を参照してください。

本プロジェクトはOneCLIを使用していません。旧文書の他プロジェクト比較や将来構想は現行の設定・認可仕様ではありません。
