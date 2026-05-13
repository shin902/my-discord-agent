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

`config/credential-proxy.json.example` をコピーして `config/credential-proxy.json` を作成する。

```json
[
  {
    "provider": "openai",
    "envVars": ["OPENAI_API_KEY"],
    "baseUrl": "https://api.openai.com/v1"
  }
]
```

**重要な挙動**:
- `envVars` は優先順位順のリスト。設定されている**最初の1つだけ**が secret として注入される。
- 同じ環境変数が複数の provider に含まれている場合、**各 provider ごとに独立して注入される**。
- `baseUrl` に `{ENV_VAR}` 形式のプレースホルダが含まれている場合、`process.env` の値で動的に置換される。置換できない場合はその provider をスキップ。
- **Azure 専用の特殊ロジック**: `provider === "azure-openai-responses"` の場合、`AZURE_OPENAI_BASE_URL` が設定されていればそちらを `baseUrl` として優先使用する。

### .env 設定

`.env.example` に全プロバイダーの環境変数がコメント付きで記載されている。使用するプロバイダの行のコメントを解除して値を設定する。

### 将来的な拡張

- OneCLI への移行
- グループごとに異なるシークレットセットを制御
- MCP サーバー用のプロキシ対応
