# @mariozechner/pi-agent-core

ツール実行とイベントストリーミングを備えたステートフルなエージェント。`@mariozechner/pi-ai` の上に構築されています。

## インストール

```bash
npm install @mariozechner/pi-agent-core
```

## クイックスタート

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "あなたは役立つアシスタントです。",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
  },
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // 新しく増えたテキストチャンクだけを出力する
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("こんにちは！");
```

## コア概念

### AgentMessage と LLM Message

このエージェントは、柔軟な型である `AgentMessage` を扱います。`AgentMessage` には以下が含まれます。
- 標準的な LLM メッセージ (`user`、`assistant`、`toolResult`)
- 宣言マージによって追加できる、アプリ固有のカスタムメッセージ型

LLM が理解できるのは `user`、`assistant`、`toolResult` だけです。`convertToLlm` 関数は、このギャップを埋めるために、各 LLM 呼び出しの前にメッセージをフィルタリングし、変換します。

### メッセージの流れ

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    (任意)                           (必須)
```

1. **transformContext**: 古いメッセージを整理し、外部コンテキストを注入する
2. **convertToLlm**: UI 専用メッセージを除外し、カスタム型を LLM 形式に変換する

## イベントの流れ

エージェントは UI 更新用のイベントを発行します。イベント順序を理解しておくと、応答性の高いインターフェースを作りやすくなります。

### prompt() のイベントシーケンス

`prompt("こんにちは")` を呼ぶと、次のようになります。

```
prompt("こんにちは")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // あなたのプロンプト
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM が応答を開始
├─ message_update  { message: partial... }       // ストリーミングチャンク
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // 完了した応答
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### ツール呼び出しあり

アシスタントがツールを呼び出す場合、ループは続きます。

```
prompt("config.json を読んで")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { toolCall を含む assistantMessage }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // ツールが進捗をストリームする場合
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // 次のターン
├─ message_start      { assistantMessage }           // LLM が toolResult に応答
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

ツール実行モードは設定可能です。

- `parallel`（デフォルト）: ツール呼び出しの事前確認を順次行い、許可されたツールを並列に実行し、各ツールが確定した時点で `tool_execution_end` を発行し、その後に assistant の元の順序で toolResult メッセージと `turn_end.toolResults` を発行する
- `sequential`: ツール呼び出しを 1 件ずつ実行し、従来の挙動に合わせる

`parallel` モードでは、ツール完了イベントは完了順に発行されますが、永続化される toolResult メッセージは引き続き assistant のソース順に従います。

このモードは、エージェント設定の `toolExecution` でグローバルに指定することも、`AgentTool` の `executionMode` でツールごとに指定することもできます。バッチ内のいずれかのツール呼び出しが `executionMode: "sequential"` のツールを対象にしている場合、グローバル設定に関係なく、そのバッチ全体が順次実行されます。

`beforeToolCall` フックは、`tool_execution_start` の後かつ引数の検証済みパースの後に実行されます。実行をブロックすることもできます。`afterToolCall` フックは、ツール実行が終わった後、`tool_execution_end` と最終的な tool result メッセージイベントが発行される前に実行されます。

ツールは `terminate: true` を返して、自動フォローアップ LLM 呼び出しをスキップするよう示すこともできます。これは、そのバッチ内のすべての確定済みツール結果が `terminate: true` を設定している場合にのみ、ループを早期終了させます。混在したバッチは通常どおり続行されます。

低レベルのループ呼び出し側は、`shouldStopAfterTurn` を使って現在のターンが完了したあとに安全に停止できます。

```typescript
const stream = agentLoop(prompts, context, {
  model,
  convertToLlm,
  shouldStopAfterTurn: async ({ message, toolResults, context, newMessages }) => {
    return shouldCompactBeforeNextTurn(context.messages);
  },
});
```

`shouldStopAfterTurn` は、`turn_end` が発行されたあと、アシスタント応答とツール実行が正常に完了したあとに実行されます。`true` を返すと、`agent_end` を発行して終了し、ステアリングやフォローアップのキューを確認する前、そして次の LLM 呼び出しを開始する前にループを抜けます。プロバイダーのストリームを中断せず、実行中のツールもキャンセルせず、assistant メッセージの停止理由も変更しません。

`Agent` クラスを使う場合、assistant の `message_end` 処理はツールの事前確認が始まる前のバリアとして扱われます。つまり、`beforeToolCall` は、ツール呼び出しを要求した assistant メッセージをすでに含むエージェント状態を見ます。

### continue() のイベントシーケンス

`continue()` は、既存のコンテキストから新しいメッセージを追加せずに再開します。エラー後の再試行に使います。

```typescript
// エラー後に現在の状態から再試行する
await agent.continue();
```

コンテキストの最後のメッセージは `user` か `toolResult` でなければなりません（`assistant` は不可です）。

### イベント種別

| イベント | 説明 |
|-------|-------------|
| `agent_start` | エージェントが処理を開始する |
| `agent_end` | 実行の最終イベント。このイベントの awaited サブスクライバーも完了待ちの対象になります |
| `turn_start` | 新しいターンが始まる（1 回の LLM 呼び出し + ツール実行） |
| `turn_end` | ターンが完了し、assistant メッセージとツール結果が確定する |
| `message_start` | どのメッセージでも開始する（user、assistant、toolResult） |
| `message_update` | **assistant のみ。** `assistantMessageEvent` を含み、差分を受け取る |
| `message_end` | メッセージが完了する |
| `tool_execution_start` | ツールが開始する |
| `tool_execution_update` | ツールが進捗をストリームする |
| `tool_execution_end` | ツールが完了する |

`Agent.subscribe()` のリスナーは、登録順に await されます。`agent_end` はこれ以上ループイベントが発行されないことを意味しますが、`await agent.waitForIdle()` と `await agent.prompt(...)` は、await された `agent_end` リスナーが完了してからでないと解決しません。

## Agent のオプション

```typescript
const agent = new Agent({
  // 初期状態
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // AgentMessage[] を LLM Message[] に変換する関数（カスタムメッセージ型に必須）
  convertToLlm: (messages) => messages.filter(...),

  // convertToLlm の前にコンテキストを変換する関数（切り詰めや圧縮に利用）
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // ステアリングモード: "one-at-a-time"（デフォルト）または "all"
  steeringMode: "one-at-a-time",

  // フォローアップモード: "one-at-a-time"（デフォルト）または "all"
  followUpMode: "one-at-a-time",

  // カスタムストリーム関数（プロキシバックエンド向け）
  streamFn: streamProxy,

  // プロバイダーのキャッシュ用セッション ID
  sessionId: "session-123",

  // 期限付き OAuth トークンなどの動的な API キー解決
  getApiKey: async (provider) => refreshToken(),

  // ツール実行モード: "parallel"（デフォルト）または "sequential"
  toolExecution: "parallel",

  // 引数の検証後、各ツール呼び出しの前に実行される。実行をブロックできる。
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash は無効です" };
    }
  },

  // 各ツール結果を、最終イベントを発行する前に後処理する。
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },

  // トークンベースのプロバイダー向けのカスタム思考予算
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

## Agent の状態

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

状態は `agent.state` からアクセスします。

`agent.state.tools = [...]` や `agent.state.messages = [...]` を代入すると、保存前に最上位の配列がコピーされます。返された配列を直接変更すると、現在のエージェント状態も変更されます。

ストリーミング中は、`agent.state.streamingMessage` に現在の途中経過の assistant メッセージが入ります。

`agent.state.isStreaming` は、`agent_end` の awaited サブスクライバーを含めて、実行が完全に完了するまで `true` のままです。

## メソッド

### プロンプト送信

```typescript
// テキストプロンプト
await agent.prompt("こんにちは");

// 画像付き
await agent.prompt("この画像には何が写っていますか？", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// AgentMessage を直接渡す
await agent.prompt({ role: "user", content: "こんにちは", timestamp: Date.now() });

// 現在のコンテキストから再開する（最後のメッセージは user または toolResult である必要がある）
await agent.continue();
```

### ステート管理

```typescript
agent.state.systemPrompt = "新しいプロンプト";
agent.state.model = getModel("openai", "gpt-4o");
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.state.messages = newMessages; // 最上位の配列はコピーされる
agent.state.messages.push(message);
agent.reset();
```

### Session と Thinking Budgets

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### 制御

```typescript
agent.abort();            // 現在の処理をキャンセルする
await agent.waitForIdle(); // 完了まで待つ
```

### イベント

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    // この run に対する最後のバリア処理
    await flushSessionState(signal);
  }
});
unsubscribe();
```

## ステアリングとフォローアップ

ステアリングメッセージを使うと、ツールが実行中でもエージェントに割り込めます。フォローアップメッセージを使うと、エージェントが止まったあとに仕事をキューできます。

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// エージェントがツールを実行中のとき
agent.steer({
  role: "user",
  content: "待って！ 代わりにこれをやって。",
  timestamp: Date.now(),
});

// エージェントが現在の作業を終えたあと
agent.followUp({
  role: "user",
  content: "結果も要約して。",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

`clearSteeringQueue`、`clearFollowUpQueue`、`clearAllQueues` を使うと、キュー済みメッセージを破棄できます。

ステアリングメッセージがターン完了後に検出された場合は、次の順序で処理されます。
1. 現在の assistant メッセージに属するすべてのツール呼び出しがすでに完了している
2. ステアリングメッセージが注入される
3. 次のターンで LLM が応答する

フォローアップメッセージは、これ以上ツール呼び出しもステアリングメッセージもない場合にのみ確認されます。キューがあれば、それらが注入され、さらに 1 ターン実行されます。

## カスタムメッセージ型

宣言マージで `AgentMessage` を拡張します。

```typescript
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// これで有効になる
const msg: AgentMessage = { role: "notification", text: "通知です", timestamp: Date.now() };
```

`convertToLlm` でカスタム型を処理します。

```typescript
const agent = new Agent({
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // 除外する
    return [m];
  }),
});
```

## ツール

`AgentTool` を使ってツールを定義します。

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "ファイルを読む",  // UI に表示するラベル
  description: "ファイルの内容を読む",
  parameters: Type.Object({
    path: Type.String({ description: "ファイルパス" }),
  }),
  // このツールの実行モードを上書きする（任意）
  // "sequential" にするとバッチ全体が 1 件ずつ実行される
  // "parallel" にすると他のツール呼び出しと同時に実行できる
  // 省略した場合はグローバルな toolExecution 設定に従う
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // 進捗をストリーム出力する（任意）
    onUpdate?.({ content: [{ type: "text", text: "読み込み中..." }], details: {} });

    // 任意で、バッチ内のすべての最終化済みツール結果が同じなら
    // 自動フォローアップ LLM 呼び出しをスキップするために `terminate: true` を返せる
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```

### エラー処理

**ツールが失敗したらエラーを投げてください。** エラーメッセージを content として返してはいけません。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`ファイルが見つかりません: ${params.path}`);
  }
  // 成功時のみ content を返す
  return { content: [{ type: "text", text: "..." }] };
}
```

投げられたエラーはエージェントによって捕捉され、`isError: true` のツールエラーとして LLM に報告されます。

`execute()` または `afterToolCall` から `terminate: true` を返すと、現在のツールバッチのあとでエージェントを停止するよう示せます。これは、バッチ内のすべての最終化済みツール結果が終了対象である場合にのみ有効です。このヒントは実行時のみ有効で、発行される `toolResult` の transcript メッセージは通常の LLM ツール結果のままです。

## プロキシ利用

ブラウザアプリがバックエンドを経由してプロキシする場合は、次のように使います。

```typescript
import { Agent, streamProxy } from "@mariozechner/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

## 低レベル API

`Agent` クラスを使わずに直接制御したい場合は、次のようにします。

```typescript
import { agentLoop, agentLoopContinue } from "@mariozechner/pi-agent-core";

const context: AgentContext = {
  systemPrompt: "あなたは役立つアシスタントです。",
  messages: [],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",  // per-tool の executionMode があればそちらが優先される
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "こんにちは", timestamp: Date.now() };

for await (const event of agentLoop([userMessage], context, config)) {
  console.log(event.type);
}

// 既存コンテキストから続行する
for await (const event of agentLoopContinue(context, config)) {
  console.log(event.type);
}
```

これらの低レベルストリームは観測専用です。イベント順序は保たれますが、あなたの async なイベント処理が完了するのを待たずに、後続の生成フェーズは進みます。メッセージ処理をツール事前確認の前のバリアとして機能させたい場合は、`agentLoop()` や `agentLoopContinue()` ではなく `Agent` クラスを使ってください。

## ライセンス

MIT