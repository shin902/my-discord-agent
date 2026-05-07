# サンドボックス（将来）

`src/sandbox/`

## nanoclaw の実装（Docker）

> 参考: `docs/clone/nanoclaw/src/container-runner.ts`
> 参考: `docs/clone/nanoclaw/src/container-runtime.ts`
> 参考: `docs/clone/nanoclaw/container/Dockerfile`

```
Session
  └── Docker container (nanoclaw-agent image)
        ├── groups/<folder>/   ← RO マウント（設定・メモリ）
        ├── data/sessions/<id>/inbound.db   ← host→container（RO）
        └── data/sessions/<id>/outbound.db  ← container→host（RW）
```

- セッションごとにコンテナを起動（`docker run --rm`）
- 通信はDBファイルのみ（IPC・stdin不使用）
- ハートビートファイルで生存確認、stale検出

## 本プロジェクトの方針

nanoclaw は通信に SQLite を使うが、本プロジェクトは **JSONL ファイルで統一**する。

```
Sandbox（Docker）
  └── Agent
        ├── groups/<folder>/  マウント（RO）
        ├── data/sessions/<groupName>/<sessionId>/inbound.jsonl   ← host→container
        ├── data/sessions/<groupName>/<sessionId>/outbound.jsonl  ← container→host
        └── → Proxy（シークレット注入） → 外部API
```

- グループの `additionalMounts` で指定したパスのみマウント許可
- `read-only` / `workspace-write` の2段階権限
- ネットワークはプロキシ経由のみ許可
