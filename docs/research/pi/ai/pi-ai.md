# @mariozechner/pi-ai

自動モデル検出、プロバイダ設定、トークンとコストの追跡、そしてセッション中に他モデルへ引き継げるシンプルなコンテキスト永続化を備えた統合 LLM API です。

**注意**: このライブラリには、エージェント的なワークフローに不可欠なツール呼び出し（function calling）をサポートするモデルだけが含まれています。

## 目次

- [対応プロバイダ](#supported-providers)
- [インストール](#installation)
- [クイックスタート](#quick-start)
- [ツール](#tools)
  - [ツールの定義](#defining-tools)
  - [ツール呼び出しの処理](#handling-tool-calls)
  - [部分 JSON を使ったストリーミングツール呼び出し](#streaming-tool-calls-with-partial-json)
  - [ツール引数の検証](#validating-tool-arguments)
  - [イベント参照一覧](#complete-event-reference)
- [画像入力](#image-input)
- [思考/推論](#thinkingreasoning)
  - [統合インターフェース (streamSimple/completeSimple)](#unified-interface-streamsimplecompletesimple)
  - [プロバイダ固有オプション (stream/complete)](#provider-specific-options-streamcomplete)
  - [思考内容のストリーミング](#streaming-thinking-content)
- [停止理由](#stop-reasons)
- [エラー処理](#error-handling)
  - [リクエストの中断](#aborting-requests)
  - [中断後の継続](#continuing-after-abort)
- [API、モデル、プロバイダ](#apis-models-and-providers)
  - [プロバイダとモデル](#providers-and-models)
  - [プロバイダとモデルの問い合わせ](#querying-providers-and-models)
  - [カスタムモデル](#custom-models)
  - [OpenAI 互換設定](#openai-compatibility-settings)
  - [型安全性](#type-safety)
- [クロスプロバイダ引き継ぎ](#cross-provider-handoffs)
- [コンテキストのシリアライズ](#context-serialization)
- [ブラウザでの利用](#browser-usage)
  - [ブラウザ互換性の注意](#browser-compatibility-notes)
  - [環境変数（Node.js 専用）](#environment-variables-nodejs-only)
  - [環境変数の確認](#checking-environment-variables)
- [OAuth プロバイダ](#oauth-providers)
  - [Vertex AI](#vertex-ai)
  - [CLI ログイン](#cli-login)
  - [プログラム的な OAuth](#programmatic-oauth)
  - [ログインフローの例](#login-flow-example)
  - [OAuth トークンの利用](#using-oauth-tokens)
  - [プロバイダ別メモ](#provider-notes)
- [ライセンス](#license)

<a id="supported-providers"></a>
## 対応プロバイダ

- **OpenAI**
- **Azure OpenAI（Responses）**
- **OpenAI Codex**（ChatGPT Plus/Pro サブスクリプションが必要、OAuth を使用。詳細は下記）
- **DeepSeek**
- **Anthropic**
- **Google**
- **Vertex AI**（Vertex AI 経由の Gemini）
- **Mistral**
- **Groq**
- **Cerebras**
- **Cloudflare AI Gateway**
- **Cloudflare Workers AI**
- **xAI**
- **OpenRouter**
- **Vercel AI Gateway**
- **MiniMax**
- **GitHub Copilot**（OAuth が必要、詳細は下記）
- **Amazon Bedrock**
- **OpenCode Zen**
- **OpenCode Go**
- **Fireworks**（Anthropic 互換 API を使用）
- **Kimi For Coding**（Moonshot AI、Anthropic 互換 API を使用）
- **Xiaomi MiMo**（Anthropic 互換 API を使用。既定では API 課金エンドポイントを使い、`cn`/`ams`/`sgp` 各リージョン向けに Token Plan プロバイダが別々にあります）
- **任意の OpenAI 互換 API**: Ollama、vLLM、LM Studio など

<a id="installation"></a>
## インストール

```bash
npm install @mariozechner/pi-ai
```

TypeBox のエクスポートは `@mariozechner/pi-ai` から再エクスポートされています: `Type`、`Static`、`TSchema`。

<a id="quick-start"></a>
## クイックスタート

```typescript
import { Type, getModel, stream, complete, Context, Tool, StringEnum } from '@mariozechner/pi-ai';

// プロバイダとモデルの両方で型補完が効く
const model = getModel('openai', 'gpt-4o-mini');

// TypeBox スキーマでツールを定義し、型安全性と検証を確保する
const tools: Tool[] = [{
  name: 'get_time',
  description: '現在時刻を取得する',
  parameters: Type.Object({
    timezone: Type.Optional(Type.String({ description: '任意のタイムゾーン（例: America/New_York）' }))
  })
}];

// 会話コンテキストを構築する（モデル間で簡単にシリアライズ／受け渡しできる）
const context: Context = {
  systemPrompt: 'あなたは役に立つアシスタントです。',
  messages: [{ role: 'user', content: '今何時ですか？' }],
  tools
};

// 1. すべてのイベント型を扱えるストリーミング
const s = stream(model, context);

for await (const event of s) {
  switch (event.type) {
    case 'start':
      console.log(`開始: ${event.partial.model}`);
      break;
    case 'text_start':
      console.log('\n[テキスト開始]');
      break;
    case 'text_delta':
      process.stdout.write(event.delta);
      break;
    case 'text_end':
      console.log('\n[テキスト終了]');
      break;
    case 'thinking_start':
      console.log('[モデルが思考中...]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);
      break;
    case 'thinking_end':
      console.log('[思考完了]');
      break;
    case 'toolcall_start':
      console.log(`\n[ツール呼び出し開始: インデックス ${event.contentIndex}]`);
      break;
    case 'toolcall_delta':
      // ツール引数が部分的にストリーミングされている
      const partialCall = event.partial.content[event.contentIndex];
      if (partialCall.type === 'toolCall') {
        console.log(`[${partialCall.name}] の引数をストリーミング中`);
      }
      break;
    case 'toolcall_end':
      console.log(`\nツール呼び出し完了: ${event.toolCall.name}`);
      console.log(`引数: ${JSON.stringify(event.toolCall.arguments)}`);
      break;
    case 'done':
      console.log(`\n完了: ${event.reason}`);
      break;
    case 'error':
      console.error(`エラー: ${event.error}`);
      break;
  }
}

// ストリーミング後に最終メッセージを取得し、コンテキストへ追加する
const finalMessage = await s.result();
context.messages.push(finalMessage);

// ツール呼び出しがあれば処理する
const toolCalls = finalMessage.content.filter(b => b.type === 'toolCall');
for (const call of toolCalls) {
  // ツールを実行する
  const result = call.name === 'get_time'
    ? new Date().toLocaleString('en-US', {
        timeZone: call.arguments.timezone || 'UTC',
        dateStyle: 'full',
        timeStyle: 'long'
      })
    : 'Unknown tool';

  // ツール結果をコンテキストへ追加する（テキストと画像に対応）
  context.messages.push({
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text', text: result }],
    isError: false,
    timestamp: Date.now()
  });
}

// ツール呼び出しがあれば継続する
if (toolCalls.length > 0) {
  const continuation = await complete(model, context);
  context.messages.push(continuation);
  console.log('ツール実行後:', continuation.content);
}

console.log(`総トークン数: 入力 ${finalMessage.usage.input}、出力 ${finalMessage.usage.output}`);
console.log(`コスト: $${finalMessage.usage.cost.total.toFixed(4)}`);

// 2. ストリーミングなしで完全な応答を取得する
const response = await complete(model, context);

for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  } else if (block.type === 'toolCall') {
    console.log(`ツール: ${block.name}(${JSON.stringify(block.arguments)})`);
  }
}
```

<a id="tools"></a>
## ツール

ツールを使うと、LLM は外部システムとやり取りできます。このライブラリでは、TypeBox スキーマを使って型安全なツール定義を行い、TypeBox の組み込みバリデータと value 変換ユーティリティで自動検証します。TypeBox スキーマはプレーン JSON としてシリアライズ／デシリアライズできるため、分散システムにも向いています。

<a id="defining-tools"></a>
### ツールの定義

```typescript
import { Type, Tool, StringEnum } from '@mariozechner/pi-ai';

// TypeBox でツール引数を定義する
const weatherTool: Tool = {
  name: 'get_weather',
  description: '現在の天気を取得する',
  parameters: Type.Object({
    location: Type.String({ description: '都市名または座標' }),
    units: StringEnum(['celsius', 'fahrenheit'], { default: 'celsius' })
  })
};

// 注意: Google API 互換性のため、Type.Enum ではなく StringEnum を使う
// Type.Enum は anyOf/const パターンを生成するが、Google はそれをサポートしていない

const bookMeetingTool: Tool = {
  name: 'book_meeting',
  description: '会議を予約する',
  parameters: Type.Object({
    title: Type.String({ minLength: 1 }),
    startTime: Type.String({ format: 'date-time' }),
    endTime: Type.String({ format: 'date-time' }),
    attendees: Type.Array(Type.String({ format: 'email' }), { minItems: 1 })
  })
};
```

<a id="handling-tool-calls"></a>
### ツール呼び出しの処理

ツール結果は content ブロックを使い、テキストと画像の両方を含められます。

```typescript
import { readFileSync } from 'fs';

const context: Context = {
  messages: [{ role: 'user', content: 'ロンドンの天気は？' }],
  tools: [weatherTool]
};

const response = await complete(model, context);

// 応答内のツール呼び出しを確認する
for (const block of response.content) {
  if (block.type === 'toolCall') {
    // 引数を使ってツールを実行する
    // 検証については「ツール引数の検証」セクションを参照
    const result = await executeWeatherApi(block.arguments);

    // テキスト content を持つツール結果を追加する
    context.messages.push({
      role: 'toolResult',
      toolCallId: block.id,
      toolName: block.name,
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
      timestamp: Date.now()
    });
  }
}

// ツール結果には画像も含められる（vision 対応モデル向け）
const imageBuffer = readFileSync('chart.png');
context.messages.push({
  role: 'toolResult',
  toolCallId: 'tool_xyz',
  toolName: 'generate_chart',
  content: [
    { type: 'text', text: '温度推移を示すチャートを生成しました' },
    { type: 'image', data: imageBuffer.toString('base64'), mimeType: 'image/png' }
  ],
  isError: false,
  timestamp: Date.now()
});
```

<a id="streaming-tool-calls-with-partial-json"></a>
### 部分 JSON を使ったストリーミングツール呼び出し

ストリーミング中は、ツール呼び出し引数が到着した順に段階的にパースされます。これにより、完全な引数が揃う前からリアルタイムで UI を更新できます。

```typescript
const s = stream(model, context);

for await (const event of s) {
  if (event.type === 'toolcall_delta') {
    const toolCall = event.partial.content[event.contentIndex];

    // toolCall.arguments には、ストリーミング中の部分 JSON が入る
    // これにより、段階的な UI 更新が可能になる
    if (toolCall.type === 'toolCall' && toolCall.arguments) {
      // 慎重に扱うこと: arguments は未完成の可能性がある
      // 例: 書き込み先ファイルのパスを、内容が完成する前に表示する
      if (toolCall.name === 'write_file' && toolCall.arguments.path) {
        console.log(`書き込み先: ${toolCall.arguments.path}`);

        // content は部分的だったり、存在しなかったりする
        if (toolCall.arguments.content) {
          console.log(`内容のプレビュー: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }

  if (event.type === 'toolcall_end') {
    // この時点では toolCall.arguments は完全な状態（まだ検証前）
    const toolCall = event.toolCall;
    console.log(`ツール完了: ${toolCall.name}`, toolCall.arguments);
  }
}
```

**部分的なツール引数に関する重要な注意点:**
- `toolcall_delta` イベント中の `arguments` には、部分 JSON を最善努力でパースした結果が入る
- フィールドが欠けていたり不完全だったりするので、使用前に必ず存在確認する
- 文字列値は単語の途中で切れることがある
- 配列は未完成の可能性がある
- ネストしたオブジェクトも部分的にしか入らないことがある
- 少なくとも `arguments` は `{}` になり、`undefined` にはならない
- Google プロバイダは function call のストリーミングをサポートしていない。そのため、完全な引数を含む単一の `toolcall_delta` イベントだけが届く

<a id="validating-tool-arguments"></a>
### ツール引数の検証

`agentLoop` を使う場合、ツール引数は実行前に TypeBox スキーマに照らして自動検証されます。検証に失敗すると、そのエラーはツール結果としてモデルに返され、モデルは再試行できます。

`stream()` または `complete()` を使って自前でツール実行ループを組む場合は、ツールへ渡す前に `validateToolCall` で引数を検証してください。

```typescript
import { stream, validateToolCall, Tool } from '@mariozechner/pi-ai';

const tools: Tool[] = [weatherTool, calculatorTool];
const s = stream(model, { messages, tools });

for await (const event of s) {
  if (event.type === 'toolcall_end') {
    const toolCall = event.toolCall;

    try {
      // ツールのスキーマに対して引数を検証する（不正なら例外）
      const validatedArgs = validateToolCall(tools, toolCall);
      const result = await executeMyTool(toolCall.name, validatedArgs);
      // ... コンテキストへツール結果を追加する
    } catch (error) {
      // 検証失敗 - モデルが再試行できるよう、エラーをツール結果として返す
      context.messages.push({
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: [{ type: 'text', text: error.message }],
        isError: true,
        timestamp: Date.now()
      });
    }
  }
}
```

<a id="complete-event-reference"></a>
### イベント参照一覧

アシスタントメッセージ生成中に発行されるストリーミングイベントは以下の通りです。

| イベント型 | 説明 | 主要プロパティ |
|------------|------|----------------|
| `start` | ストリーム開始 | `partial`: 初期のアシスタントメッセージ構造 |
| `text_start` | テキストブロック開始 | `contentIndex`: content 配列内の位置 |
| `text_delta` | テキスト断片を受信 | `delta`: 新しいテキスト、`contentIndex`: 位置 |
| `text_end` | テキストブロック完了 | `content`: 完全なテキスト、`contentIndex`: 位置 |
| `thinking_start` | 思考ブロック開始 | `contentIndex`: content 配列内の位置 |
| `thinking_delta` | 思考断片を受信 | `delta`: 新しいテキスト、`contentIndex`: 位置 |
| `thinking_end` | 思考ブロック完了 | `content`: 完全な思考内容、`contentIndex`: 位置 |
| `toolcall_start` | ツール呼び出し開始 | `contentIndex`: content 配列内の位置 |
| `toolcall_delta` | ツール引数のストリーミング | `delta`: JSON 断片、`partial.content[contentIndex].arguments`: 部分的にパースされた引数 |
| `toolcall_end` | ツール呼び出し完了 | `toolCall`: `id`、`name`、`arguments` を含む完全な検証済みツール呼び出し |
| `done` | ストリーム完了 | `reason`: 停止理由（`"stop"`、`"length"`、`"toolUse"`）、`message`: 最終アシスタントメッセージ |
| `error` | エラー発生 | `reason`: エラー種別（`"error"` または `"aborted"`）、`error`: 部分コンテンツを含む AssistantMessage |

<a id="image-input"></a>
## 画像入力

vision 機能を持つモデルは画像を処理できます。モデルが画像入力をサポートしているかどうかは `input` プロパティで確認できます。画像を非 vision モデルに渡しても、画像は静かに無視されます。

```typescript
import { readFileSync } from 'fs';
import { getModel, complete } from '@mariozechner/pi-ai';

const model = getModel('openai', 'gpt-4o-mini');

// モデルが画像をサポートしているか確認する
if (model.input.includes('image')) {
  console.log('このモデルは vision をサポートしています');
}

const imageBuffer = readFileSync('image.png');
const base64Image = imageBuffer.toString('base64');

const response = await complete(model, {
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'この画像には何が写っていますか？' },
      { type: 'image', data: base64Image, mimeType: 'image/png' }
    ]
  }]
});

// 応答を確認する
for (const block of response.content) {
  if (block.type === 'text') {
    console.log(block.text);
  }
}
```

<a id="thinkingreasoning"></a>
## 思考/推論

多くのモデルは、内部の思考過程を見せられる reasoning / thinking 機能をサポートしています。モデルが推論をサポートしているかどうかは `reasoning` プロパティで確認できます。推論オプションを非対応モデルに渡しても、無視されます。

<a id="unified-interface-streamsimplecompletesimple"></a>
### 統合インターフェース (streamSimple/completeSimple)

```typescript
import { getModel, streamSimple, completeSimple } from '@mariozechner/pi-ai';

// 多くのプロバイダで思考/推論をサポートするモデルがある
const model = getModel('anthropic', 'claude-sonnet-4-20250514');
// または getModel('openai', 'gpt-5-mini');
// または getModel('google', 'gemini-2.5-flash');
// または getModel('xai', 'grok-code-fast-1');
// または getModel('groq', 'openai/gpt-oss-20b');
// または getModel('cerebras', 'gpt-oss-120b');
// または getModel('openrouter', 'z-ai/glm-4.5v');

// モデルが推論をサポートしているか確認する
if (model.reasoning) {
  console.log('このモデルは reasoning/thinking をサポートしています');
}

// 簡易推論オプションを使う
const response = await completeSimple(model, {
  messages: [{ role: 'user', content: '2x + 5 = 13 を解いてください' }]
}, {
  reasoning: 'medium'  // 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
});

// 思考ブロックとテキストブロックを参照する
for (const block of response.content) {
  if (block.type === 'thinking') {
    console.log('思考:', block.thinking);
  } else if (block.type === 'text') {
    console.log('応答:', block.text);
  }
}
```

<a id="provider-specific-options-streamcomplete"></a>
### プロバイダ固有オプション (stream/complete)

細かい制御が必要な場合は、プロバイダ固有オプションを使います。

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';

// OpenAI の推論（o1, o3, gpt-5）
const openaiModel = getModel('openai', 'gpt-5-mini');
await complete(openaiModel, context, {
  reasoningEffort: 'medium',
  reasoningSummary: 'detailed'  // OpenAI Responses API のみ
});

// Anthropic の思考（Claude Sonnet 4）
const anthropicModel = getModel('anthropic', 'claude-sonnet-4-20250514');
await complete(anthropicModel, context, {
  thinkingEnabled: true,
  thinkingBudgetTokens: 8192  // 任意のトークン上限
});

// Google Gemini の思考
const googleModel = getModel('google', 'gemini-2.5-flash');
await complete(googleModel, context, {
  thinking: {
    enabled: true,
    budgetTokens: 8192  // -1 は動的、0 は無効化
  }
});
```

<a id="streaming-thinking-content"></a>
### 思考内容のストリーミング

ストリーミング時、思考内容は専用イベントとして配信されます。

```typescript
const s = streamSimple(model, context, { reasoning: 'high' });

for await (const event of s) {
  switch (event.type) {
    case 'thinking_start':
      console.log('[モデルが思考を開始]');
      break;
    case 'thinking_delta':
      process.stdout.write(event.delta);  // 思考内容をストリーミングする
      break;
    case 'thinking_end':
      console.log('\n[思考完了]');
      break;
  }
}
```

## 停止理由

各 `AssistantMessage` には、生成がどのように終わったかを示す `stopReason` フィールドがあります。

- `"stop"` - 正常終了。モデルは応答を出し切った
- `"length"` - 出力が最大トークン数に達した
- `"toolUse"` - モデルがツールを呼び出しており、ツール結果を待っている
- `"error"` - 生成中にエラーが発生した
- `"aborted"` - abort シグナルによってリクエストがキャンセルされた

`AssistantMessage` には、`responseId` が含まれる場合もあります。これは、基盤 API が提供している場合に限って使える、プロバイダ固有の upstream 応答 ID です。常に存在するとは限らない点に注意してください。

<a id="error-handling"></a>
## エラー処理

リクエストがエラーで終わるとき（abort やツール呼び出し検証エラーを含む）、ストリーミング API は error イベントを発行します。

```typescript
// ストリーミング時
for await (const event of stream) {
  if (event.type === 'error') {
    // event.reason は "error" か "aborted"
    // event.error は部分コンテンツを含む AssistantMessage
    console.error(`エラー (${event.reason}):`, event.error.errorMessage);
    console.log('部分コンテンツ:', event.error.content);
  }
}

// 最終メッセージにはエラー詳細が入る
const message = await stream.result();
if (message.stopReason === 'error' || message.stopReason === 'aborted') {
  console.error('リクエスト失敗:', message.errorMessage);
  // message.content には、エラー前に受信した部分コンテンツが入る
  // message.usage には、部分的なトークン数とコストが入る
}
```

<a id="aborting-requests"></a>
### リクエストの中断

abort シグナルを使うと、進行中のリクエストをキャンセルできます。中断されたリクエストの `stopReason` は `"aborted"` になります。

```typescript
import { getModel, stream } from '@mariozechner/pi-ai';

const model = getModel('openai', 'gpt-4o-mini');
const controller = new AbortController();

// 2 秒後に中断する
setTimeout(() => controller.abort(), 2000);

const s = stream(model, {
  messages: [{ role: 'user', content: '長い物語を書いてください' }]
}, {
  signal: controller.signal
});

for await (const event of s) {
  if (event.type === 'text_delta') {
    process.stdout.write(event.delta);
  } else if (event.type === 'error') {
    // event.reason で "error" か "aborted" かを判定できる
    console.log(`${event.reason === 'aborted' ? '中断' : 'エラー'}:`, event.error.errorMessage);
  }
}

// 結果を取得する（中断されていれば部分的な内容の可能性がある）
const response = await s.result();
if (response.stopReason === 'aborted') {
  console.log('リクエストは中断されました:', response.errorMessage);
  console.log('受信済みの部分コンテンツ:', response.content);
  console.log('使用トークン:', response.usage);
}
```

<a id="continuing-after-abort"></a>
### 中断後の継続

中断されたメッセージは会話コンテキストに追加でき、その後のリクエストで続きから再開できます。

```typescript
const context = {
  messages: [
    { role: 'user', content: '量子コンピューティングを詳しく説明してください' }
  ]
};

// 1 回目のリクエストは 2 秒後に中断される
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);

const partial = await complete(model, context, { signal: controller1.signal });

// 部分応答をコンテキストに追加する
context.messages.push(partial);
context.messages.push({ role: 'user', content: '続けてください' });

// 会話を継続する
const continuation = await complete(model, context);
```

### プロバイダ payload のデバッグ

`onPayload` コールバックを使うと、プロバイダへ送信するリクエスト payload を確認できます。リクエスト形式の不具合や、プロバイダのバリデーションエラーを調べるときに便利です。

```typescript
const response = await complete(model, context, {
  onPayload: (payload) => {
    console.log('プロバイダ payload:', JSON.stringify(payload, null, 2));
  }
});
```

このコールバックは `stream`、`complete`、`streamSimple`、`completeSimple` で利用できます。

<a id="apis-models-and-providers"></a>
## API、モデル、プロバイダ

このライブラリは API 実装のレジストリを使っています。組み込み API は次の通りです。

- **`anthropic-messages`**: Anthropic Messages API（`streamAnthropic`、`AnthropicOptions`）
- **`google-generative-ai`**: Google Generative AI API（`streamGoogle`、`GoogleOptions`）
- **`google-vertex`**: Google Vertex AI API（`streamGoogleVertex`、`GoogleVertexOptions`）
- **`mistral-conversations`**: Mistral Conversations API（`streamMistral`、`MistralOptions`）
- **`openai-completions`**: OpenAI Chat Completions API（`streamOpenAICompletions`、`OpenAICompletionsOptions`）
- **`openai-responses`**: OpenAI Responses API（`streamOpenAIResponses`、`OpenAIResponsesOptions`）
- **`openai-codex-responses`**: OpenAI Codex Responses API（`streamOpenAICodexResponses`、`OpenAICodexResponsesOptions`）
- **`azure-openai-responses`**: Azure OpenAI Responses API（`streamAzureOpenAIResponses`、`AzureOpenAIResponsesOptions`）
- **`bedrock-converse-stream`**: Amazon Bedrock Converse API（`streamBedrock`、`BedrockOptions`）

### テスト用の faux プロバイダ

`registerFauxProvider()` は、テストやデモ向けに使える一時的なインメモリプロバイダを登録します。組み込みプロバイダには含まれておらず、必要なときだけ有効にする方式です。

```typescript
import {
  complete,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  registerFauxProvider,
  stream,
} from '@mariozechner/pi-ai';

const registration = registerFauxProvider({
  tokensPerSecond: 50 // 任意
});

const model = registration.getModel();
const context = {
  messages: [{ role: 'user', content: 'package.json を要約してから echo を呼んでください', timestamp: Date.now() }]
};

registration.setResponses([
  fauxAssistantMessage([
    fauxThinking('まず package metadata を確認する必要があります。'),
    fauxToolCall('echo', { text: 'package.json' })
  ], { stopReason: 'toolUse' })
]);

const first = await complete(model, context, {
  sessionId: 'session-1',
  cacheRetention: 'short'
});
context.messages.push(first);

context.messages.push({
  role: 'toolResult',
  toolCallId: first.content.find((block) => block.type === 'toolCall')!.id,
  toolName: 'echo',
  content: [{ type: 'text', text: 'package.json の内容です' }],
  isError: false,
  timestamp: Date.now()
});

registration.setResponses([
  fauxAssistantMessage([
    fauxThinking('これでツール出力を要約できます。'),
    fauxText('これが要約です。')
  ])
]);

const s = stream(model, context);
for await (const event of s) {
  console.log(event.type);
}

// 複数の faux モデルを登録して、モデル切り替えテストにも使える
const multiModel = registerFauxProvider({
  models: [
    { id: 'faux-fast', reasoning: false },
    { id: 'faux-thinker', reasoning: true }
  ]
});
const thinker = multiModel.getModel('faux-thinker');

console.log(thinker?.reasoning);
console.log(registration.getPendingResponseCount());
console.log(registration.state.callCount);
registration.unregister();
multiModel.unregister();
```

注意:
- 応答は、リクエスト開始順にキューから消費される
- キューが空の場合、faux プロバイダは `errorMessage: "No more faux responses queued"` を持つアシスタントエラーを返す
- `registration.setResponses([...])` で残りのキューを置き換え、`registration.appendResponses([...])` で応答を追加できる
- `registration.models` は登録済みの faux モデルをすべて公開する。`registration.getModel()` は先頭のモデルを返し、`registration.getModel(id)` は指定 ID のモデルを返す
- `fauxAssistantMessage(...)` でスクリプト化したアシスタント応答を作れる。`fauxText(...)`、`fauxThinking(...)`、`fauxToolCall(...)` を使うと、低レベルフィールドを手で埋めずに content ブロックを組み立てられる
- `registration.unregister()` は一時的なプロバイダをグローバル API レジストリから削除する
- 使用量はおおむね 4 文字あたり 1 トークンとして見積もられる。`sessionId` があり、`cacheRetention` が `"none"` でない場合、プロンプトキャッシュの読み書きが自動的にシミュレートされる
- ツール呼び出し引数は `toolcall_delta` チャンクとして段階的に流れる
- 既定では各ストリーミングチャンクは個別の microtask で送られる。リアルタイムにしたい場合は `tokensPerSecond` を設定する
- 意図された使い方は、1 回の registration ごとに決定的なスクリプトフロー 1 つです。独立した並行フローが必要なら、個別の faux プロバイダを登録してください

<a id="providers-and-models"></a>
### プロバイダとモデル

**プロバイダ** は、特定の API を通じてモデルを提供します。たとえば:
- **Anthropic** モデルは `anthropic-messages` API を使う
- **Google** モデルは `google-generative-ai` API を使う
- **OpenAI** モデルは `openai-responses` API を使う
- **Mistral** モデルは `mistral-conversations` API を使う
- **xAI、Cerebras、Groq など** のモデルは `openai-completions` API を使う（OpenAI 互換）

<a id="querying-providers-and-models"></a>
### プロバイダとモデルの問い合わせ

```typescript
import { getProviders, getModels, getModel } from '@mariozechner/pi-ai';

// 利用可能なすべてのプロバイダを取得する
const providers = getProviders();
console.log(providers); // ['openai', 'anthropic', 'google', 'xai', 'groq', ...]

// プロバイダ内のすべてのモデルを取得する（完全に型付けされる）
const anthropicModels = getModels('anthropic');
for (const model of anthropicModels) {
  console.log(`${model.id}: ${model.name}`);
  console.log(`  API: ${model.api}`); // 'anthropic-messages'
  console.log(`  Context: ${model.contextWindow} tokens`);
  console.log(`  Vision: ${model.input.includes('image')}`);
  console.log(`  Reasoning: ${model.reasoning}`);
}

// 特定のモデルを取得する（IDE でプロバイダ ID とモデル ID の両方が補完される）
const model = getModel('openai', 'gpt-4o-mini');
console.log(`Using ${model.name} via ${model.api} API`);
```

<a id="custom-models"></a>
### カスタムモデル

ローカル推論サーバーや独自エンドポイント向けに、カスタムモデルを作成できます。

```typescript
import { Model, stream } from '@mariozechner/pi-ai';

// 例: OpenAI 互換 API を使う Ollama
const ollamaModel: Model<'openai-completions'> = {
  id: 'llama-3.1-8b',
  name: 'Llama 3.1 8B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000
};

// 例: 明示的な compat 設定を持つ LiteLLM プロキシ
const litellmModel: Model<'openai-completions'> = {
  id: 'gpt-4o',
  name: 'GPT-4o (via LiteLLM)',
  api: 'openai-completions',
  provider: 'litellm',
  baseUrl: 'http://localhost:4000/v1',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
  compat: {
    supportsStore: false,  // LiteLLM は store フィールドをサポートしない
  }
};

// 例: ヘッダ付きのカスタムエンドポイント（Cloudflare の bot 検知回避など）
const proxyModel: Model<'anthropic-messages'> = {
  id: 'claude-sonnet-4',
  name: 'Claude Sonnet 4 (Proxied)',
  api: 'anthropic-messages',
  provider: 'custom-proxy',
  baseUrl: 'https://proxy.example.com/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'X-Custom-Auth': 'bearer-token-here'
  }
};

// カスタムモデルを使う
const response = await stream(ollamaModel, context, {
  apiKey: 'dummy' // Ollama に実際のキーは不要
});
```

OpenAI 互換サーバーの中には、推論対応モデルが使う `developer` ロールを理解しないものがあります。その場合は `compat.supportsDeveloperRole` を `false` にして、system prompt を `system` メッセージとして送るようにします。さらに `reasoning_effort` も非対応なら、`compat.supportsReasoningEffort` も `false` にしてください。

モデルレベルの `thinkingLevelMap` を使うと、モデル固有の思考制御を表現できます。キーは pi の thinking レベル（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`）です。存在しないキーはプロバイダの既定値が使われ、文字列値はそのままプロバイダへ送られ、`null` はそのレベルが未対応であることを示します。

この設定は、Ollama、vLLM、SGLang、その他類似の OpenAI 互換サーバーでよく使われます。`compat` はプロバイダレベルまたはモデルごとに設定できます。

```typescript
const ollamaReasoningModel: Model<'openai-completions'> = {
  id: 'gpt-oss:20b',
  name: 'GPT-OSS 20B (Ollama)',
  api: 'openai-completions',
  provider: 'ollama',
  baseUrl: 'http://localhost:11434/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32000,
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
  },
  compat: {
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
  }
};
```

<a id="openai-compatibility-settings"></a>
### OpenAI 互換設定

`openai-completions` API は多くのプロバイダで実装されていますが、細かな差異があります。既定では、このライブラリは既知の OpenAI 互換プロバイダ（Cerebras、xAI、Chutes、DeepSeek、zAi、OpenCode、Cloudflare Workers AI など）について、`baseUrl` から互換設定を自動検出します。カスタムプロキシや未知のエンドポイントでは、`compat` フィールドで上書きできます。`openai-responses` モデルでは、`compat` は Responses 固有のフラグのみを扱います。

```typescript
interface OpenAICompletionsCompat {
  supportsStore?: boolean;           // プロバイダが `store` フィールドをサポートするか（既定: true）
  supportsDeveloperRole?: boolean;   // `developer` ロールを `system` の代わりに使えるか（既定: true）
  supportsReasoningEffort?: boolean; // `reasoning_effort` をサポートするか（既定: true）
  supportsUsageInStreaming?: boolean; // `stream_options: { include_usage: true }` をサポートするか（既定: true）
  supportsStrictMode?: boolean;      // ツール定義の `strict` をサポートするか（既定: true）
  sendSessionAffinityHeaders?: boolean; // キャッシュ有効時に `sessionId` 由来の `session_id`、`x-client-request-id`、`x-session-affinity` を送るか（既定: false）
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';  // 使うフィールド名（既定: `max_completion_tokens`）
  requiresToolResultName?: boolean;  // ツール結果に `name` フィールドが必要か（既定: false）
  requiresAssistantAfterToolResult?: boolean; // ツール結果の後に assistant メッセージが必要か（既定: false）
  requiresThinkingAsText?: boolean;  // thinking ブロックを text に変換する必要があるか（既定: false）
  requiresReasoningContentOnAssistantMessages?: boolean; // reasoning 有効時、再生した assistant メッセージに空の reasoning_content が必要か（既定: DeepSeek は自動検出）
  thinkingFormat?: 'openai' | 'deepseek' | 'zai' | 'qwen' | 'qwen-chat-template'; // 推論パラメータの形式: 'openai' は reasoning_effort、'deepseek' は thinking: { type } と reasoning_effort、'zai' は enable_thinking、'qwen' は enable_thinking、'qwen-chat-template' は chat_template_kwargs.enable_thinking（既定: openai）
  cacheControlFormat?: 'anthropic';  // system prompt、最後の tool、最後の user/assistant text content に Anthropic 形式の cache_control を付ける
  openRouterRouting?: OpenRouterRouting; // OpenRouter のルーティング設定（既定: {}）
  vercelGatewayRouting?: VercelGatewayRouting; // Vercel AI Gateway のルーティング設定（既定: {}）
}

interface OpenAIResponsesCompat {
  // 将来用の予約
}
```

`compat` が設定されていない場合、このライブラリは URL ベースの検出にフォールバックします。`compat` が部分的に設定されている場合、未指定のフィールドは検出された既定値が使われます。これは次のような用途で便利です。

- **LiteLLM プロキシ**: `store` フィールドをサポートしないことがある
- **カスタム推論サーバー**: 非標準のフィールド名を使うことがある
- **セルフホスト型エンドポイント**: 機能サポートが異なることがある

<a id="type-safety"></a>
### 型安全性

モデルは API ごとに型付けされており、モデルのメタデータが正確に保たれます。プロバイダ専用のオプション型は、直接プロバイダ関数を呼ぶときに強制されます。汎用の `stream` と `complete` は、追加のプロバイダフィールドを含む `StreamOptions` を受け取ります。

```typescript
import { streamAnthropic, type AnthropicOptions } from '@mariozechner/pi-ai';

// これは Anthropic モデルとして TypeScript に認識される
const claude = getModel('anthropic', 'claude-sonnet-4-20250514');

const options: AnthropicOptions = {
  thinkingEnabled: true,
  thinkingBudgetTokens: 2048
};

await streamAnthropic(claude, context, options);
```

<a id="cross-provider-handoffs"></a>
## クロスプロバイダ引き継ぎ

このライブラリは、同じ会話の中で異なる LLM プロバイダ間をシームレスに引き継げます。これにより、thinking ブロック、ツール呼び出し、ツール結果を含むコンテキストを保ったまま、会話途中でモデルを切り替えられます。

### 仕組み

あるプロバイダのメッセージを別のプロバイダへ送るとき、このライブラリは互換性のために自動変換を行います。

- **ユーザーとツール結果のメッセージ** はそのまま通す
- **同じプロバイダ/API 由来の assistant メッセージ** はそのまま保持する
- **別プロバイダ由来の assistant メッセージ** は、thinking ブロックを `<thinking>` タグ付きテキストへ変換する
- **ツール呼び出しと通常テキスト** はそのまま保持する

### 例: マルチプロバイダ会話

```typescript
import { getModel, complete, Context } from '@mariozechner/pi-ai';

// まず Claude で開始する
const claude = getModel('anthropic', 'claude-sonnet-4-20250514');
const context: Context = {
  messages: []
};

context.messages.push({ role: 'user', content: '25 * 18 はいくつですか？' });
const claudeResponse = await complete(claude, context, {
  thinkingEnabled: true
});
context.messages.push(claudeResponse);

// GPT-5 に切り替える - Claude の thinking は <thinking> タグ付きテキストとして見える
const gpt5 = getModel('openai', 'gpt-5-mini');
context.messages.push({ role: 'user', content: 'その計算は正しいですか？' });
const gptResponse = await complete(gpt5, context);
context.messages.push(gptResponse);

// Gemini に切り替える
const gemini = getModel('google', 'gemini-2.5-flash');
context.messages.push({ role: 'user', content: '元の質問は何でしたか？' });
const geminiResponse = await complete(gemini, context);
```

### プロバイダ互換性

すべてのプロバイダは、以下を含む他プロバイダ由来のメッセージを扱えます。
- テキスト content
- ツール呼び出しとツール結果（ツール結果内の画像を含む）
- thinking / reasoning ブロック（クロスプロバイダ互換のためタグ付きテキストへ変換）
- 中断されたメッセージとその部分コンテンツ

これにより、柔軟なワークフローを実現できます。
- まず高速モデルで初期応答を得る
- より高性能なモデルへ切り替えて複雑な推論を任せる
- 特定タスク向けの専用モデルを使う
- プロバイダ障害をまたいで会話の継続性を保つ

<a id="context-serialization"></a>
## コンテキストのシリアライズ

`Context` オブジェクトは標準的な JSON メソッドで簡単にシリアライズ／デシリアライズできます。会話の永続化、チャット履歴の実装、サービス間でのコンテキスト転送が簡単になります。

```typescript
import { Context, getModel, complete } from '@mariozechner/pi-ai';

// コンテキストを作成して使う
const context: Context = {
  systemPrompt: 'あなたは役に立つアシスタントです。',
  messages: [
    { role: 'user', content: 'TypeScript とは何ですか？' }
  ]
};

const model = getModel('openai', 'gpt-4o-mini');
const response = await complete(model, context);
context.messages.push(response);

// コンテキスト全体をシリアライズする
const serialized = JSON.stringify(context);
console.log('シリアライズ後のサイズ:', serialized.length, 'bytes');

// DB、localStorage、ファイルなどに保存する
localStorage.setItem('conversation', serialized);

// 後で復元して会話を続ける
const restored: Context = JSON.parse(localStorage.getItem('conversation')!);
restored.messages.push({ role: 'user', content: '型システムについてもっと教えてください' });

// どのモデルでも続行できる
const newModel = getModel('anthropic', 'claude-3-5-haiku-20241022');
const continuation = await complete(newModel, restored);
```

> **注意**: コンテキストに画像（画像入力セクションのように base64 でエンコードされたもの）が含まれていても、それらもシリアライズ対象になります。

<a id="browser-usage"></a>
## ブラウザでの利用

このライブラリはブラウザ環境でも利用できます。ブラウザでは環境変数が使えないため、API キーは明示的に渡す必要があります。

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';

// ブラウザでは API キーを明示的に渡す必要がある
const model = getModel('anthropic', 'claude-3-5-haiku-20241022');

const response = await complete(model, {
  messages: [{ role: 'user', content: 'こんにちは！' }]
}, {
  apiKey: 'your-api-key'
});
```

> **セキュリティ警告**: フロントエンドコードに API キーを埋め込むのは危険です。誰でもキーを抜き取って悪用できます。社内ツールやデモ用途に限って使ってください。本番アプリでは、API キーを安全に保持するバックエンドプロキシを使ってください。

<a id="browser-compatibility-notes"></a>
### ブラウザ互換性の注意

- Amazon Bedrock（`bedrock-converse-stream`）はブラウザ環境ではサポートされません。
- OAuth ログインフローはブラウザ環境ではサポートされません。Node.js では `@mariozechner/pi-ai/oauth` エントリーポイントを使ってください。
- ブラウザビルドでは Bedrock がモデル一覧に表示されることがありますが、実際の呼び出しは実行時に失敗します。
- Web アプリから Bedrock や OAuth ベースの認証を使いたい場合は、サーバー側プロキシまたはバックエンドサービスを使ってください。

<a id="environment-variables-nodejs-only"></a>
### 環境変数（Node.js 専用）

Node.js 環境では、API キーを都度渡さずに済むよう環境変数を設定できます。

| プロバイダ | 環境変数 |
|----------|--------|
| OpenAI | `OPENAI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL`（例: `https://{resource}.openai.azure.com`）または `AZURE_OPENAI_RESOURCE_NAME`。`*.openai.azure.com` と `*.cognitiveservices.azure.com` の両方をサポートし、ルートエンドポイントは自動で `/openai/v1` に正規化されます。任意: `AZURE_OPENAI_API_VERSION`（既定 `v1`）、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`。 |
| Anthropic | `ANTHROPIC_API_KEY` または `ANTHROPIC_OAUTH_TOKEN` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Google | `GEMINI_API_KEY` |
| Vertex AI | `GOOGLE_CLOUD_API_KEY` または `GOOGLE_CLOUD_PROJECT`（または `GCLOUD_PROJECT`）+ `GOOGLE_CLOUD_LOCATION` + ADC |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| zAI | `ZAI_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| OpenCode Zen / OpenCode Go | `OPENCODE_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Xiaomi MiMo（API 課金） | `XIAOMI_API_KEY` |
| Xiaomi MiMo Token Plan（中国） | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| Xiaomi MiMo Token Plan（アムステルダム） | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| Xiaomi MiMo Token Plan（シンガポール） | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` または `GH_TOKEN` または `GITHUB_TOKEN` |

設定されている場合、ライブラリはこれらのキーを自動で使います。

```typescript
// 環境変数の OPENAI_API_KEY を使う
const model = getModel('openai', 'gpt-4o-mini');
const response = await complete(model, context);

// 明示的なキーで上書きすることもできる
const response = await complete(model, context, {
  apiKey: 'sk-different-key'
});
```

<a id="checking-environment-variables"></a>
### 環境変数の確認

```typescript
import { getEnvApiKey } from '@mariozechner/pi-ai';

// 環境変数に API キーがあるか確認する
const key = getEnvApiKey('openai');  // OPENAI_API_KEY を確認する
```

<a id="oauth-providers"></a>
## OAuth プロバイダ

いくつかのプロバイダは、静的な API キーではなく OAuth 認証を必要とします。

- **Anthropic**（Claude Pro/Max サブスクリプション）
- **OpenAI Codex**（ChatGPT Plus/Pro サブスクリプション、GPT-5.x Codex モデルへのアクセス）
- **GitHub Copilot**（Copilot サブスクリプション）

有料の Cloud Code Assist サブスクリプションを使う場合は、`GOOGLE_CLOUD_PROJECT` または `GOOGLE_CLOUD_PROJECT_ID` にプロジェクト ID を設定してください。

<a id="vertex-ai"></a>
### Vertex AI

Vertex AI モデルは、Google Cloud API キーまたは Application Default Credentials（ADC）のどちらでも使えます。

- **API キー**: `GOOGLE_CLOUD_API_KEY` を設定するか、呼び出しオプションで `apiKey` を渡す
- **ローカル開発（ADC）**: `gcloud auth application-default login` を実行する
- **CI / 本番（ADC）**: サービスアカウント JSON キーファイルを指すよう `GOOGLE_APPLICATION_CREDENTIALS` を設定する

ADC を使う場合は、`GOOGLE_CLOUD_PROJECT`（または `GCLOUD_PROJECT`）と `GOOGLE_CLOUD_LOCATION` も設定してください。呼び出しオプションで `project` / `location` を渡すこともできます。`GOOGLE_CLOUD_API_KEY` を使う場合は、`project` と `location` は不要です。

例:

```bash
# ローカル（ユーザー認証を使う）
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI / 本番（サービスアカウント鍵ファイルを使う）
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';

(async () => {
  const model = getModel('google-vertex', 'gemini-2.5-flash');
  const response = await complete(model, {
    messages: [{ role: 'user', content: 'Vertex AI からこんにちは' }]
  }, {
    apiKey: process.env.GOOGLE_CLOUD_API_KEY,
  });

  for (const block of response.content) {
    if (block.type === 'text') console.log(block.text);
  }
})().catch(console.error);
```

公式ドキュメント: [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

<a id="cli-login"></a>
### CLI ログイン

最短で認証する方法は次の通りです。

```bash
npx @mariozechner/pi-ai login              # 対話式のプロバイダ選択
npx @mariozechner/pi-ai login anthropic    # 特定プロバイダにログイン
npx @mariozechner/pi-ai list               # 利用可能なプロバイダ一覧
```

認証情報は、現在のディレクトリ内の `auth.json` に保存されます。

<a id="programmatic-oauth"></a>
### プログラム的な OAuth

このライブラリは、`@mariozechner/pi-ai/oauth` エントリーポイント経由でログインとトークン更新関数を提供します。資格情報の保存は呼び出し側の責任です。

```typescript
import {
  // ログイン関数（資格情報を返すだけで保存しない）
  loginAnthropic,
  loginOpenAICodex,
  loginGitHubCopilot,
  loginGeminiCli,

  // トークン管理
  refreshOAuthToken,   // (provider, credentials) => 新しい資格情報
  getOAuthApiKey,      // (provider, credentialsMap) => { newCredentials, apiKey } | null

  // 型
  type OAuthProvider,
  type OAuthCredentials,
} from '@mariozechner/pi-ai/oauth';
```

<a id="login-flow-example"></a>
### ログインフローの例

```typescript
import { loginGitHubCopilot } from '@mariozechner/pi-ai/oauth';
import { writeFileSync } from 'fs';

const credentials = await loginGitHubCopilot({
  onAuth: (url, instructions) => {
    console.log(`開く: ${url}`);
    if (instructions) console.log(instructions);
  },
  onPrompt: async (prompt) => {
    return await getUserInput(prompt.message);
  },
  onProgress: (message) => console.log(message)
});

// 資格情報は自分で保存する
const auth = { 'github-copilot': { type: 'oauth', ...credentials } };
writeFileSync('auth.json', JSON.stringify(auth, null, 2));
```

<a id="using-oauth-tokens"></a>
### OAuth トークンの利用

`getOAuthApiKey()` を使うと、期限切れなら自動更新しながら API キーを取得できます。

```typescript
import { getModel, complete } from '@mariozechner/pi-ai';
import { getOAuthApiKey } from '@mariozechner/pi-ai/oauth';
import { readFileSync, writeFileSync } from 'fs';

// 保存済みの資格情報を読み込む
const auth = JSON.parse(readFileSync('auth.json', 'utf-8'));

// API キーを取得する（期限切れなら更新される）
const result = await getOAuthApiKey('github-copilot', auth);
if (!result) throw new Error('ログインしていません');

// 更新後の資格情報を保存する
auth['github-copilot'] = { type: 'oauth', ...result.newCredentials };
writeFileSync('auth.json', JSON.stringify(auth, null, 2));

// API キーを使う
const model = getModel('github-copilot', 'gpt-4o');
const response = await complete(model, {
  messages: [{ role: 'user', content: 'こんにちは！' }]
}, { apiKey: result.apiKey });
```

<a id="provider-notes"></a>
### プロバイダ別メモ

**OpenAI Codex**: ChatGPT Plus または Pro サブスクリプションが必要です。拡張コンテキストウィンドウと推論機能を備えた GPT-5.x Codex モデルが使えます。このライブラリは、`sessionId` が stream オプションに渡された場合、セッションベースのプロンプトキャッシュを自動処理します。Codex Responses の transport 選択として、stream オプションの `transport` に `"sse"`、`"websocket"`、`"auto"` を設定できます。WebSocket を `sessionId` と組み合わせて使う場合、接続はセッション単位で再利用され、5 分間操作がないと期限切れになります。

**Azure OpenAI（Responses）**: Responses API のみを使います。`AZURE_OPENAI_API_KEY` と `AZURE_OPENAI_BASE_URL` または `AZURE_OPENAI_RESOURCE_NAME` を設定してください。`AZURE_OPENAI_BASE_URL` は `https://<resource>.openai.azure.com` と `https://<resource>.cognitiveservices.azure.com` の両方に対応し、ルートエンドポイントは自動的に `.../openai/v1` に正規化されます。必要に応じて `AZURE_OPENAI_API_VERSION`（既定は `v1`）で API バージョンを上書きできます。デプロイ名は既定ではモデル ID として扱われます。`azureDeploymentName` または `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` で `model-id=deployment` のカンマ区切りペア（例: `gpt-4o-mini=my-deployment,gpt-4o=prod`）を使って上書きできます。従来のデプロイメントベース URL は意図的に非対応です。

**GitHub Copilot**: 「The requested model is not supported」エラーが出る場合は、VS Code で手動有効化してください。Copilot Chat を開き、モデルセレクタをクリックし、警告アイコン付きのモデルを選んで、「Enable」をクリックします。

<a id="license"></a>
## ライセンス

MIT
