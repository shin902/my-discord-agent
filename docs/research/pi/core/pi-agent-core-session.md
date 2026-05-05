# pi-agent-core セッション管理・運用ガイド

pi-agent-core を使った Discord ボット開発における、セッション管理・トークンキャッシュ・OpenCode Go 連携の実装メモ。

---

## 1. セッション管理（Resume）

### pi-agent-core の制限

組み込みのセッション永続化機能（`resumeSession(sessionId)` 型）は**ありません**。

ただし、**状態（state）を自前で保存・復元すれば、同等のresumeは実現できます**。

### 実装例

```typescript
// --- セーブ ---
const agentState = {
  systemPrompt: agent.state.systemPrompt,
  modelConfig: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
  thinkingLevel: agent.state.thinkingLevel,
  messages: agent.state.messages, // AgentMessage[] を JSON 化
  sessionId: agent.sessionId,     // 同じsessionIdを維持することが重要
};

await fs.writeFile("session.json", JSON.stringify(agentState, null, 2));

// --- ロード（resume） ---
const saved = JSON.parse(await fs.readFile("session.json", "utf-8"));

const agent = new Agent({
  initialState: {
    systemPrompt: saved.systemPrompt,
    model: getModel(saved.modelConfig.provider, saved.modelConfig.modelId),
    thinkingLevel: saved.thinkingLevel,
    messages: saved.messages,
    tools: [/* tools は再設定が必要 */],
  },
  sessionId: saved.sessionId, // 同じsessionIdを再利用
});
```

### 注意点

| 項目 | 説明 |
|------|------|
| **`tools`** | `execute` 関数はシリアライズできないので、復元時にツール定義を再構築・再設定する必要があります |
| **`model`** | `Model` インスタンスもシリアライズできないので、`getModel()` などで再作成します |
| **`subscribe`** | イベントリスナーは復元後に再登録が必要です |
| **ストリーミング状態** | 保存時にストリーミング中だった場合、それは失われます（messages のみ保存） |
| **カスタムメッセージ型** | 独自の `AgentMessage` 型を拡張している場合、適切なシリアライザが必要です |

---

## 2. トークンキャッシュの考察

### 結論: プロバイダーと設定次第で「効く」ことがある

pi-ai（pi-agent-coreの下位ライブラリ）には `sessionId` と `cacheRetention` というキャッシュ制御用の仕組みがあります。ただし、**save/resume しても「毎回同じメッセージを再送する」という点は変わらない**ため、キャッシュの種類によって効き方が異なります。

### プロバイダー別キャッシュ効果

| プロバイダー | save/resume後のキャッシュ効果 | キーとなる設定 |
|-----------|---------------------------|-------------|
| **Anthropic** | ◎ 読み取りコストが大幅削減（毎回全送信は必要） | `sessionId` + `cacheRetention` + `cacheControlFormat: 'anthropic'` |
| **OpenAI Codex** | ◎ セッション継続で再送信不要の可能性 | `sessionId` + `transport: 'websocket'` |
| **OpenAI 標準** | △ 自動キャッシュに任せるしかない | `sendSessionAffinityHeaders: true`（限定的） |
| **その他** | △ プロバイダー依存 | 各種 `compat` 設定 |

### 重要なポイント

- save/resumeで自前のセッション管理を実装する場合、**同じ `sessionId` を維持し続ける**ことがキャッシュ効率の鍵
- DiscordのスレッドIDなどを `sessionId` に使うと、自然にこの条件を満たせる
- ただし、OpenCode GoのOpenAI互換APIでは、**`sessionId` 由来のヘッダー送信はデフォルトで無効**（`sendSessionAffinityHeaders: false`）
- キャッシュ効果は「あるかもしれない」程度で、それを前提にしない方が良い

---

## 3. OpenCode Go 調査結果

### 概要

**OpenCode Go**は、人気のオープンソースコーディングエージェント「OpenCode」（anomalyco/opencode、GitHubスター155K）が提供する**低価格定額サブスクリプション**です。

- **料金**: 初月$5、その後$10/月
- **目的**: オープンソースモデルへの信頼性のある低コストアクセス
- **ホスト地域**: US, EU, Singapore（グローバルアクセス向け）
- **プライバシー**: ゼロリテンションポリシー（データを学習に使用しない）

### 利用可能なモデル

| モデル | 特徴 |
|--------|------|
| **Kimi K2.6** | 高性能コーディングモデル |
| **Kimi K2.5** | K2.6の姉妹モデル |
| **GLM-5 / GLM-5.1** | 高機能モデル |
| **DeepSeek V4 Pro / Flash** | 高速・低コスト版あり |
| **Qwen3.5 Plus / Qwen3.6 Plus** | Alibaba系、コスパ良好 |
| **MiMo-V2シリーズ** | Xiaomi系 |
| **MiniMax M2.5 / M2.7** | コスパ重視 |

### 利用制限（定額枠）

| 期間 | 制限 |
|------|------|
| **5時間あたり** | $12相当 |
| **週間** | $30相当 |
| **月間** | $60相当 |

制限超過後は、**Zenの従量課金クレジットに自動フォールバック**可能（設定で有効化が必要）。

### API仕様・pi-aiでの使い方

**エンドポイント**: `https://opencode.ai/zen/go/v1/chat/completions`（OpenAI互換）

```typescript
import { getModel } from '@mariozechner/pi-ai';

const model = getModel('opencode-go', 'kimi-k2.6');
// または
const model = getModel('opencode-go', 'deepseek-v4-pro');
```

**環境変数**: `OPENCODE_API_KEY`

### OpenCode Go vs Zen

| 項目 | Go | Zen |
|------|-----|-----|
| **料金体系** | 定額 $10/月（+制限） | 従量課金（クレジット制） |
| **対象モデル** | オープンソースモデルのみ | オープン+プロプライエタリ（Claude, GPT等） |
| **Kimi K2.6の料金** | 定額枠内で使い放題 | $0.95/1M input, $4.00/1M output |
| **使い分け** | 低コスト・大量利用向け | 高品質・プロプライエタリモデル向け |

---

## 4. 独自セッションID管理の推奨設計

### 結論

**DiscordスレッドIDをセッションIDに紐付けるのは最適な設計**です。

### 実装例

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

interface PersistentSession {
  sessionId: string;
  threadId: string;
  systemPrompt: string;
  messages: AgentMessage[];
  modelProvider: string;
  modelId: string;
  lastActivityAt: number;
}

class DiscordSessionManager {
  private tools: AgentTool<any>[];
  
  constructor(tools: AgentTool<any>[]) {
    this.tools = tools;
  }

  async getOrCreateSession(threadId: string): Promise<Agent> {
    const saved = await this.loadFromDB(threadId);
    
    if (saved) {
      // === RESUME ===
      return new Agent({
        initialState: {
          systemPrompt: saved.systemPrompt,
          model: getModel(saved.modelProvider, saved.modelId),
          messages: saved.messages,
          tools: this.tools,
        },
        sessionId: saved.sessionId, // 同じsessionIdを維持
        transformContext: async (messages) => {
          return this.pruneOldMessages(messages);
        },
      });
    }

    // === NEW ===
    const sessionId = `discord-${threadId}-${Date.now()}`;
    return new Agent({
      initialState: {
        systemPrompt: "あなたはDiscordの役立つアシスタントです。",
        model: getModel('opencode-go', 'kimi-k2.6'),
        tools: this.tools,
      },
      sessionId,
    });
  }

  async save(threadId: string, agent: Agent): Promise<void> {
    const state: PersistentSession = {
      sessionId: agent.sessionId,
      threadId,
      systemPrompt: agent.state.systemPrompt,
      messages: agent.state.messages,
      modelProvider: extractProvider(agent.state.model),
      modelId: extractModelId(agent.state.model),
      lastActivityAt: Date.now(),
    };
    await db.save(`session:${threadId}`, state);
  }
}
```

### Discordイベントとの連携

```typescript
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  
  const threadId = message.channel.isThread() 
    ? message.channel.id 
    : message.id;
  
  const agent = await sessionManager.getOrCreateSession(threadId);
  
  agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      message.channel.sendTyping();
    }
  });

  await agent.prompt(message.content);
  await sessionManager.save(threadId, agent);
});
```

### 評価

| 観点 | 評価 |
|------|------|
| **実装の必要性** | ⭐⭐⭐ 必須。pi-agent-coreには組み込みresumeがない |
| **DiscordスレッドIDとの相性** | ⭐⭐⭐ 最適。自然にスレッド=セッションの分離ができる |
| **キャッシュ効果の期待** | ⭐⭐☆ 限定的。OpenCode GoのOpenAI互換APIではあまり期待できない |
| **コスト効率** | ⭐⭐⭐ $10/月の定額制なので、キャッシュ効果がなくても十分安い |
| **メンテナンス性** | ⭐⭐⭐ 自前実装だが、シンプルなJSON保存で十分 |

---

## 5. 総合推奨事項

### 技術スタックの選定

| レイヤー | 推奨 | 理由 |
|----------|------|------|
| **Agent SDK** | `pi-agent-core` | Discordボットとの統合のしやすさ、フックの豊富さ、ステアリング/フォローアップ機能 |
| **モデルプロバイダー** | `OpenCode Go` | $10/月の定額制でKimi K2.6等が使い放題。コスパが最高 |
| **セッション管理** | 自前実装（上記設計参照） | pi-agent-coreには組み込みがないが、DiscordスレッドIDと紐付けることで自然に実現 |
| **キャッシュ戦略** | 過度な期待はせず、定額制のコストでカバー | 必要になったらZenのAnthropic Claudeに切り替えを検討 |

### 次のアクション

1. `pi-agent-core` + `OpenCode Go` の組み合わせでプロトタイプ作成
2. `DiscordSessionManager` クラスの実装
3. Discordスレッドごとのセッション分離の動作確認
4. 必要に応じて `transformContext` でのコンテキスト切り詰め実装

---

*調査日: 2026-05-05*
