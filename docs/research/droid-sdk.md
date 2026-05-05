# @factory/droid-sdk

[Factory](https://factory.ai) の Droid CLI 向け TypeScript SDK です。Droid をサブプロセスとして扱うための高レベル API を提供し、ストリーミングメッセージ、多段階セッション、Spec モード、ツール制御、初期化メタデータ、セッションのフォーク、セッションの検索、ツール権限の扱いをサポートします。

## 要件

- **Node.js 18 以上**
- `droid` CLI がインストールされ、PATH 上で利用可能であること

## インストール

```bash
npm install @factory/droid-sdk
```

## クイックスタート

一度だけプロンプトを送って、応答をストリーミングで受け取る例です。

```ts
import { query } from '@factory/droid-sdk';

const stream = query({
  prompt: 'What files are in the current directory?',
  cwd: '/my/project',
});

for await (const msg of stream) {
  if (msg.type === 'assistant_text_delta') {
    process.stdout.write(msg.text);
  }
  if (msg.type === 'turn_complete') {
    console.log('\nDone!');
  }
}
```

## マルチターンセッション

`createSession()` を使うと、複数ターンにまたがる対話を継続できます。

```ts
import { createSession } from '@factory/droid-sdk';

const session = await createSession({ cwd: '/my/project' });

// ストリーミングのターン
for await (const msg of session.stream('List all TypeScript files')) {
  if (msg.type === 'assistant_text_delta') {
    process.stdout.write(msg.text);
  }
}

// 非ストリーミングのターン
const result = await session.send('Summarize the project');
console.log(result.text);

await session.close();
```

ID を指定して既存のセッションを再開することもできます。

```ts
import { resumeSession } from '@factory/droid-sdk';

const session = await resumeSession('session-id-here');
const result = await session.send('Continue where we left off');
console.log(result.text);
await session.close();
```

返される `DroidSession` には `session.initResult` もあり、JSON-RPC サーバーが返した生の `initialize_session` または `load_session` の結果が入っています。

## 初期化メタデータ

`query()`、`createSession()`、`resumeSession()` から返る初期化メタデータの生データを確認できます。

```ts
import { createSession, query, resumeSession } from '@factory/droid-sdk';

const stream = query({
  prompt: 'Reply with "ready" and nothing else.',
  cwd: '/my/project',
});

console.log(stream.sessionId); // 初期化前は null
console.log(stream.initResult); // 初期化前は null

const initialized = await stream.initialized;
console.log(initialized.sessionId);
console.log(initialized.settings.modelId);
stream.abort();

const session = await createSession({ cwd: '/my/project' });
console.log(session.initResult.settings.modelId);

const resumed = await resumeSession(session.sessionId, { cwd: '/my/project' });
console.log(resumed.initResult.cwd);

await resumed.close();
await session.close();
```

## Spec モード

セッションを直接 Spec モードで開始することも、既存セッションで後から Spec モードに入ることもできます。

```ts
import {
  createSession,
  DroidInteractionMode,
  ReasoningEffort,
} from '@factory/droid-sdk';

const session = await createSession({
  cwd: '/my/project',
  interactionMode: DroidInteractionMode.Spec,
  specModeReasoningEffort: ReasoningEffort.High,
  specModeModelId: 'claude-sonnet-4-20250514',
});

const plan = await session.send('Draft a plan for adding integration tests');
console.log(plan.text);

await session.enterSpecMode({
  specModeReasoningEffort: ReasoningEffort.High,
});

await session.close();
```

Spec モードの承認を扱うときは、`ToolConfirmationOutcome.ProceedOnce` で同じセッションのまま実装を承認することも、`ToolConfirmationOutcome.ProceedNewSessionHigh` で新しいセッションへ引き継ぐこともできます。

## ツール制御

セッション開始時に利用可能な exec ツールを制御し、現在のツールカタログを確認し、あとからオーバーライドを更新できます。

```ts
import { createSession } from '@factory/droid-sdk';

const session = await createSession({
  cwd: '/my/project',
  enabledToolIds: ['Read'],
  disabledToolIds: ['Execute'],
});

const { tools } = await session.listTools();
console.log(
  tools.map((tool) => ({
    id: tool.llmId,
    allowed: tool.currentlyAllowed,
  }))
);

await session.updateSettings({
  disabledToolIds: ['Read', 'Execute'],
});

await session.close();
```

## セッションのフォーク

現在のサーバー側セッションをフォークして、新しいセッション ID で続行します。

```ts
import { createSession, resumeSession } from '@factory/droid-sdk';

const session = await createSession({ cwd: '/my/project' });

await session.send('Remember this phrase: mango sunrise');

const { newSessionId } = await session.forkSession();
const fork = await resumeSession(newSessionId, { cwd: '/my/project' });

const result = await fork.send('What phrase did I ask you to remember?');
console.log(result.text);

await fork.close();
await session.close();
```

## セッション一覧

droid セッションをディスク上から発見します。CLI の `/sessions` コマンドに相当します。`~/.factory/sessions/` を直接読むため、droid プロセスが起動していなくても動作します。

```ts
import { listSessions } from '@factory/droid-sdk';

// 現在のプロジェクトのセッション（cwd の既定値は process.cwd()）
const current = await listSessions();

// 現在のプロジェクトで最近の 10 件
const recent = await listSessions({ numSessions: 10 });

// ディスク上のすべてのセッションを新しい順で取得
const all = await listSessions({ fetchOutsideCWD: true });

// 全プロジェクト横断で最近の 10 件
const recentAcrossProjects = await listSessions({
  fetchOutsideCWD: true,
  numSessions: 10,
});

// 別の特定プロジェクトのセッション
const other = await listSessions({ cwd: '/Users/me/other-repo' });

for (const s of current) {
  console.log(`[${s.id}] ${s.title} (${s.messageCount} msgs)`);
}
```

各 `SessionMetadata` レコードには `id`、`title`、`sessionTitle`、`owner`、`messageCount`、`modifiedTime`、`createdTime`、`isFavorite`、`cwd`、`decompSessionType`、`decompMissionId` が含まれます。設定ファイルに `archivedAt` を持つアーカイブ済みセッションは自動的に除外されます。結果は `modifiedTime` の降順で並びます。

`ListSessionsOptions`:

- **`cwd`** — 一覧を絞り込む作業ディレクトリ。既定は `process.cwd()` です。`fetchOutsideCWD` が `true` の場合は無視されます。
- **`fetchOutsideCWD`** — ディスク上のすべての作業ディレクトリのセッションを返します。既定は `false` です。
- **`numSessions`** — 返すセッション数の上限
- **`sessionsDir`** — セッションのルートを上書きします。既定は `~/.factory/sessions/` です。

## 権限制御

カスタムの権限ハンドラーを使って、ツールの確認要求を処理できます。

```ts
import { query, ToolConfirmationOutcome } from '@factory/droid-sdk';

const stream = query({
  prompt: 'Create a hello.txt file',
  cwd: '/my/project',
  permissionHandler(params) {
    console.log('Tool permission requested:', params);
    return ToolConfirmationOutcome.ProceedOnce;
  },
});

for await (const msg of stream) {
  if (msg.type === 'assistant_text_delta') {
    process.stdout.write(msg.text);
  }
}
```

## API リファレンス

### トップレベル関数

| 関数                          | 説明                                                     |
| ---------------------------- | -------------------------------------------------------- |
| `query(options)`             | 一度だけのプロンプト → `DroidMessage` イベントの async generator |
| `createSession(options?)`    | 新しいマルチターンセッションを作成 → `DroidSession`      |
| `resumeSession(id, options?)` | 既存セッションを再開 → `DroidSession`                    |
| `listSessions(options?)`     | ディスク上に保存された droid セッションを一覧表示 → `Promise<SessionMetadata[]>` |

### `query(options): DroidQuery`

`DroidMessage` イベントを返す async generator を返します。返り値の `DroidQuery` には次のプロパティもあります。

- **`interrupt()`** — エージェントの現在のターンを穏やかに中断します
- **`abort()`** — サブプロセスを強制終了します
- **`sessionId`** — セッション ID（初期化後に利用可能）
- **`initResult`** — キャッシュされた `initialize_session` の結果、または初期化前は `null`
- **`initialized`** — `initialize_session` の結果で解決する promise

`query(options)` は外部からのキャンセル用に `abortSignal` も受け取ります。

### `DroidSession`

`createSession()` と `resumeSession()` が返す値です。主なメソッドは次のとおりです。

- **`stream(text, options?)`** — メッセージを送信し、`DroidMessage` の async generator を返します
- **`send(text, options?)`** — メッセージを送信し、集約済みの `DroidResult` を返します
- **`interrupt()`** — 現在のターンを中断します
- **`close()`** — セッションを閉じ、リソースを解放します
- **`updateSettings(params)`** — モデルや自律性レベルなどを更新します
- **`enterSpecMode(params?)`** — 現在のセッションを Spec モードに切り替えます
- **`forkSession()`** — サーバー側でセッションをフォークし、新しいセッション ID を返します
- **`addMcpServer(params)`** / **`removeMcpServer(params)`** — MCP サーバーを管理します
- **`listTools(params?)`** — exec ツールカタログと現在の許可/拒否状態を確認します
- **`renameSession(params)`** — 現在のセッション名を変更します
- **`sessionId`** — セッション ID
- **`initResult`** — キャッシュされた `initialize_session` または `load_session` の結果

### `DroidResult`

`session.send()` が返します。

- **`text`** — 結合済みのアシスタント応答テキスト
- **`messages`** — そのターンのすべての `DroidMessage` オブジェクト
- **`tokenUsage`** — 最終的な token 使用量。ない場合は `null`

### `DroidMessage` の型

すべてのメッセージには識別用の `type` フィールドがあります。

| Type                    | 説明                                 |
| ----------------------- | ------------------------------------ |
| `assistant_text_delta`  | アシスタントからのストリーミング文字列断片 |
| `thinking_text_delta`   | 推論/思考のストリーミング文字列断片       |
| `tool_use`              | アシスタントによるツール呼び出し         |
| `tool_result`           | ツール実行の結果                       |
| `tool_progress`         | ツール実行中の進捗更新                 |
| `working_state_changed` | エージェントの作業状態の遷移           |
| `token_usage_update`    | 更新された token 使用量カウンタ        |
| `create_message`        | 完成したアシスタントメッセージ         |
| `turn_complete`         | センチネル: エージェントのターン完了   |
| `session_title_updated` | セッションタイトルの更新               |
| `error`                 | プロセスからのエラーイベント           |

### オプション

`QueryOptions` と `CreateSessionOptions` は次を受け取ります。

- **`prompt`** — ユーザープロンプト（query のみ）
- **`cwd`** — セッションの作業ディレクトリ
- **`modelId`** — LLM のモデル識別子
- **`autonomyLevel`** — `AutonomyLevel` の列挙値
- **`interactionMode`** — `DroidInteractionMode` の列挙値
- **`reasoningEffort`** — `ReasoningEffort` の列挙値
- **`specModeModelId`** — Spec モードで使うモデルの上書き
- **`specModeReasoningEffort`** — Spec モードで使う推論レベルの上書き
- **`enabledToolIds`** — 明示的な exec ツールの許可リスト
- **`disabledToolIds`** — 明示的な exec ツールの拒否リスト
- **`permissionHandler`** — ツール確認用コールバック
- **`askUserHandler`** — 対話的な質問用コールバック
- **`abortSignal`** — 標準の `AbortSignal` によるキャンセル
- **`execPath`** — `droid` 実行ファイルのパス（既定: `"droid"`）
- **`transport`** — プロセス起動の代わりにカスタム transport を指定

### `DroidClient`

上級者向けの低レベル JSON-RPC クライアントです。`listTools()` や `renameSession()` を含む、基盤プロトコル操作の型付きメソッドを提供します。通常は `query()` と `createSession()` を使う方がよいです。

### エラー型

| Error                  | 説明                                   |
| ---------------------- | -------------------------------------- |
| `ConnectionError`      | droid プロセスへの接続に失敗した       |
| `ProtocolError`        | JSON-RPC のプロトコルエラー            |
| `SessionError`         | セッションエラーの基底クラス          |
| `SessionNotFoundError` | セッション ID が見つからない          |
| `TimeoutError`         | リクエストがタイムアウトした           |
| `ProcessExitError`     | Droid サブプロセスが予期せず終了した   |

## 例

実行可能な例は [`examples/`](./examples) ディレクトリを参照してください。

- **[`simple-query.ts`](./examples/simple-query.ts)** — ストリーミング出力付きの一度だけの query
- **[`multi-turn-session.ts`](./examples/multi-turn-session.ts)** — マルチターンセッションのライフサイクル
- **[`init-metadata.ts`](./examples/init-metadata.ts)** — query/session API から初期化・ロードのメタデータを読む
- **[`permission-handler.ts`](./examples/permission-handler.ts)** — カスタム権限処理
- **[`spec-mode-same-session.ts`](./examples/spec-mode-same-session.ts)** — Spec を承認し、同じセッションで続行する
- **[`spec-mode-new-session.ts`](./examples/spec-mode-new-session.ts)** — Spec を承認し、実装を新しいセッションに引き継ぐ
- **[`tool-controls.ts`](./examples/tool-controls.ts)** — 許可/拒否リストを設定し、ツールの利用可否を確認する
- **[`fork-session.ts`](./examples/fork-session.ts)** — セッションをフォークして、新しいセッション ID から続行する
- **[`list-sessions.ts`](./examples/list-sessions.ts)** — ディスク上の droid セッションを検索する

## ライセンス

Apache 2.0