# my-discord-agent レビューレポート

**レビュー日**: 2026-05-23
**レビュー対象バージョン**: 0.1.0
**レビュー観点**: nanoclaw v2 で得た知見を交え、JSONL・ファイルベース構成を維持したまま改善できる箇所

---

## 概要

`my-discord-agent` は nanoclaw v1 の経験を活かし、"確実に動く"ことを重視した Discord 専用 AI エージェントボットです。
ホスト・サンドボックスの2層構造、JSONL ベースのセッション・キュー管理、`microsandbox` を使ったツール実行隔離など、堅実な設計が特徴です。

本レポートでは、**データベースへの移行は行わず**、既存の JSONL・ファイル構成を維持したままで解決できる、構造的な改善点を優先度順に記載します。

---

## 高優先度

### 1. セッション JSONL の書き込み競合ロック

**問題**: `src/agent/session.ts` の `appendMessage()` は単純な `appendFile` です。同一セッションに対して複数のメッセージが並行処理されると、JSONL の行が途中で混ざり、ファイルが破損する可能性があります。

**シナリオ**:
1. チャンネルAでユーザーが2連投
2. `channelChain` はチャンネル単位で直列化するが、コンテナ起動・実行は非同期的
3. コンテナ1とコンテナ2がほぼ同時に `appendMessage("groupA", "sessionX", ...)` を呼ぶ
4. `appendFile` は Node.js レベルで atomic ではないため、2行が混ざる

**nanoclaw v2 の対比**: v2 は根本解決のため `inbound.db` と `outbound.db` を分離し、書き込み者を1つにしました。あなたの規模では JSONL のままで「セッション単位の書き込み直列化」を入れるだけで十分安全です。

**推奨対策**:

```ts
// src/agent/session.ts
const sessionLocks = new Map<string, Promise<void>>();

function withSessionLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionKey) ?? Promise.resolve();
  const next = prev.then(fn, () => fn()).finally(() => {
    if (sessionLocks.get(sessionKey) === next) sessionLocks.delete(sessionKey);
  });
  sessionLocks.set(sessionKey, next);
  return next;
}

export async function appendMessage(
  groupName: string,
  sessionId: string,
  message: AgentMessage,
): Promise<void> {
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");
  const key = `${groupName}/${sessionId}`;
  return withSessionLock(key, async () => {
    await ensureDir(groupName);
    const { reasoning: _r, ...rest } = message as AgentMessage & { reasoning?: unknown };
    const sanitized: Record<string, unknown> = { ...rest };
    if (hasArrayContent(rest)) {
      sanitized.content = rest.content.filter((b) => b.type !== "thinking");
    }
    const filePath = sessionPath(groupName, sessionId);
    await chmod(filePath, 0o666).catch(() => {});
    await appendFile(filePath, `${JSON.stringify(sanitized)}\n`, { encoding: "utf-8", mode: 0o666 });
  });
}
```

### 2. コンテナ起動コスト（Docker Pull Policy）

**問題**: `src/agent/manager.ts` で `pullPolicy("always")` を指定しています。ローカルレジストリ (`localhost:5050`) 向けに毎回 pull を試みるため、**1メッセージごとのコンテナ起動・破棄**がさらに遅くなります。

**推奨対策**:

```ts
builder
  .image("localhost:5050/my-discord-agent-runner:latest")
  .pullPolicy("never")  // ローカルレジストリの場合は "never" で十分
  // .pullPolicy("missing") // 必要に応じて
```

**補足**: 中長期的には「セッションごとにコンテナを使い回し」や「プール方式」の導入を検討してください。現状の「1メッセージ = 1コンテナ起動」は Discord の応答レイテンシに大きく影響します。

---

## 中優先度

### 3. リトライによるチャンネル詰まり

**問題**: `src/queue/poller.ts` でリトライ時に `sleep(retryDelay)` した後に `return` しています。これにより、**そのチャンネルの `channelChain` はリトライ待ちの間ブロック**され、他のメッセージが処理できません。

```ts
const retryDelay = Math.min(1000 * 2 ** msg.retries, 60000);
await sleep(retryDelay);  // ここで待つ間、channelChain は this promise を待つ
return;
```

**推奨対策**: メッセージに `retryAfter` タイムスタンプを付与し、poller は即座に次のメッセージを処理できるようにします。

```ts
// src/queue/inbox.ts
export interface InboxMessage {
  // ...既存フィールド
  retryAfter?: string; // ISO timestamp
}

// src/queue/poller.ts
async function poll(): Promise<void> {
  while (running) {
    if (client.isReady()) {
      const msg = await shiftInbox();
      if (msg) {
        if (msg.retryAfter && new Date(msg.retryAfter) > new Date()) {
          await prependInbox(msg); // 先頭に戻して
          await sleep(POLL_MS);    // 短い間隔で再確認
          continue;
        }
        dispatchWithChannelLock(msg.channelId, () => processMessage(msg));
        continue;
      }
    }
    await sleep(POLL_MS);
  }
}

// processMessage 内のリトライ処理
if (msg.retries + 1 < MAX_RETRIES) {
  const retryAfter = new Date(Date.now() + Math.min(1000 * 2 ** msg.retries, 60000));
  await prependInbox({ ...msg, retries: msg.retries + 1, retryAfter: retryAfter.toISOString() });
  return; // sleep なしで即 return
}
```

### 4. 設定・スキルのホットリロード

**問題**: `src/config/group-config.ts` と `src/config/groups.ts` は起動時に1回だけ読み込み、以降キャッシュを固定します。`group.json` や `AGENTS.md`、チャンネル設定を変更しても**再起動が必要**です。

**推奨対策（config.json の例）**:

```ts
// src/config/groups.ts
let _groupsMtime = 0;

export async function loadGroups(): Promise<GroupConfig[]> {
  const stats = await stat(CONFIG_PATH).catch(() => null);
  const mtime = stats?.mtimeMs ?? 0;
  if (_groups !== null && _groupsMtime >= mtime) return _groups;

  let text: string;
  try {
    text = await readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("config/config.json が見つかりません");
    }
    throw err;
  }
  _groups = GroupsConfigSchema.parse(JSON.parse(text));
  _groupsMtime = mtime;
  return _groups;
}
```

`group-config.ts` も同様に `group.json` / `AGENTS.md` の `mtime` を確認して再読み込みしてください。

### 5. エージェント実行イベントの記録

**問題**: コンテナ内のエージェントがどのツールを呼んだか、何回プロンプトしたか、などの**実行履歴がホストから見えません**。デバッグ時に「なぜこの応答が返ってきたか」が不透明です。

**推奨対策**: セッション JSONL にツール呼び出し・エラー・メタデータも追記する拡張を検討してください。

```ts
// src/agent/session.ts
export interface SessionEvent {
  type: "tool_call" | "tool_result" | "error" | "system";
  timestamp: string;
  data: unknown;
}

export async function appendEvent(
  groupName: string,
  sessionId: string,
  event: SessionEvent,
): Promise<void> {
  // appendMessage と同様の withSessionLock 直列化で追記
}
```

nanoclaw v2 では `outbound.db` にこのようなメタデータを書き込むことで、ホスト側がコンテナ内の動作を観測しています。

---

## 低優先度

### 6. inbox.jsonl の fsync（クラッシュ耐性）

**問題**: `appendInbox` は `appendFile` 後に `fsync` を呼んでいません。OS クラッシュや突然のプロセス kill で、書き込んだはずのメッセージが失われる可能性があります。

**推奨対策**: デッドレターなど重要な状態変更には `fsync` を入れ、inbox 本体はパフォーマンス優先で `appendFile` のままにする、という折衷が現実的です。もし厳密な耐久性が必要な場合：

```ts
import { open } from "node:fs/promises";
const fh = await open(INBOX_PATH, "a");
await fh.appendFile(`${JSON.stringify(record)}\n`);
await fh.sync();
await fh.close();
```

### 7. `/workspace` の容量監視

**問題**: コンテナ内で `write` ツールを使ったファイルは `/workspace`（`groups/<name>`）に残り続けます。エージェントが大量のファイルを書くとディスクを圧迫します。

**推奨対策**: 定期的な容量チェックや、セッション終了後のクリーンアップポリシーをドキュメント化してください。ただしユーザーデータの消失には注意が必要です。

### 8. typing indicator の開始タイミング

**問題**: `startTypingLoop` は `processMessage` の最初に開始されますが、実際の「メッセージ受信」から「タイピング開始」までの間に、キュー待ち・前メッセージ処理待ちが入ることがあります。

**推奨対策**: `appendInbox` 成功直後（または Discord イベント受信直後）に typing を開始すると、ユーザーの待ち時間感が改善します。

---

## テスト網羅性の気になる点

現存のテストは `inbox.test.ts`（競合ロック）、`session.test.ts`（JSONL I/O）、`poller.test.ts`（モック）など充実していますが、以下のカバレッジが不足しています：

- **`manager.ts` のエラーハンドリングパス**: `NonRetryableError`（タイムアウト）/`TransientError`（exit code 2）/モデル設定エラー の分岐がテストされていない
- **`config.ts` のキャッシュ無効化**: ファイル変更後の再読み込みパスがテストされていない
- **セッション並行書き込み**: `session.test.ts` に混線テストを追加すべき

---

## 結論・推奱アクション

1. **即座に**: `session.ts` に `withSessionLock` を導入し、JSONL 破損リスクを解消する
2. **次に**: `pullPolicy("always")` を `"never"` に変更し、コンテナ起動レイテンシを改善する
3. **今週中**: リトライ `sleep` を `retryAfter` パターンに変更し、チャンネル詰まりを解消する
4. **今月中**: 設定ファイルの `mtime` ベース再読み込みを実装し、ホットリロードを可能にする
5. **継続的に**: `SessionEvent` 追記機構を導入し、エージェント動作の可観測性を向上させる

これらの変更はいずれも JSONL・ファイル構成を維持したままで実現可能です。データベース移行のコストをかけずに、堅牢性と運用性を大きく向上できます。
