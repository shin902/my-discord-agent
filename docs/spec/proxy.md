# プロキシサーバー（クレデンシャル安全挿入）

`src/proxy/`

## 目的

エージェントが使う MCP サーバーや外部 API へのリクエストを中継し、APIキー等のシークレットをエージェントに直接渡さずに注入する。

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

## 本プロジェクトの方針

初期フェーズはシンプルに実装：

```
Agent → src/proxy/（.envからシークレットを読んでヘッダに注入） → 外部API / MCP
```

- `.env` で管理されているシークレットをプロキシ側のみが保持
- グループごとに異なるシークレットセットを `group.json` の `secrets` フィールドで参照
- 将来的にOneCLIへ移行可能な設計にしておく
