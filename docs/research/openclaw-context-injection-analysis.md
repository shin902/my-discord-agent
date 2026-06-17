# openclaw のコンテキスト注入方式と pi-agent-core との関係

Issue #117（AGENTS.md / MEMORY.md の初回のみ注入）の実装方針を固めるために、openclaw リポジトリ（`docs/clone/openclaw/`、参照用クローン）の実装を調査した記録。

> **実装結果（PR #122 マージ済み）**: 本調査が推奨した **経路 B（pi-agent-core 標準の `CustomMessage`）** を採用した。
> 当初仕様の tool_use/tool_result ペア（経路 A）は不採用。実装の最終形は末尾「7. 実装結果」を参照。
> 仕様書: `docs/spec/initial-context-injection.md`。

---

## TL;DR

1. **openclaw の AGENTS.md は「システムプロンプト文字列への結合」方式**。user メッセージでも tool_result でもない。
2. ただし AGENTS.md を毎ターン注入しつつも「プロンプトキャッシュが効く」のは、**ランタイムを維持するから**（my-discord-agent の使い捨て Agent とは前提が違う）。
3. openclaw が「初回のみ」を実現しているのは **独自の `role: "custom"` + `customType` 型**（`@openclaw/agent-core`）。これは **pi-agent-core のフォーク独自機能**。
4. **`@openclaw/agent-core` はプライベートパッケージ（npm 非公開）。外部からは使えない。**
5. my-discord-agent が使う `@earendil-works/pi-agent-core` には、同等のフック（`CustomAgentMessages` / `convertToLlm` / `transformContext`）が **標準で存在する**。これを使えば openclaw の方式の利点だけを軽量に得られる見込み。

---

## 1. openclaw は AGENTS.md をどう注入しているか

### 結論: システムプロンプトに文字列結合

AGENTS.md はディスクから読み込まれ、システムプロンプトの `# Project Context` セクションに直接結合される。user メッセージでも tool_use/tool_result ペアでもない。

| 項目 | 内容 | 出典 |
|------|------|------|
| ディスク読み込み | `loadWorkspaceBootstrapFiles()` が 8 候補ファイルを固定順（AGENTS.md 先頭）で読む | `src/agents/workspace.ts:1016-1081` |
| 中間データ構造 | `EmbeddedContextFile = { path, content }` | `src/agents/embedded-agent-helpers/types.ts:2` |
| **注入形式** | **システムプロンプト文字列に結合**（`# Project Context` 下） | `src/agents/system-prompt.ts:202-238` |
| タイミング | 毎ターン再評価 + スナップショットキャッシュ | `src/agents/bootstrap-cache.ts:47-69` |

> **副次証拠**: `src/agents/` 全体で `tool_result.*AGENTS` / `synthetic.*user.*bootstrap` を grep → 該当コードゼロ。tool_result や user メッセージとして注入する経路は存在しない。

### プロンプトキャッシュを効かせる工夫（核心）

```
[安定プレフィックス] ← AGENTS.md / SOUL.md / MEMORY.md / Skills
<!-- OPENCLAW_CACHE_BOUNDARY -->   ← system-prompt-cache-boundary.ts:8
[動的サフィックス]   ← 日付 / ハートビート / チャネル固有ガイダンス
```

- AGENTS.md 等は「stable」、`heartbeat.md` のみ「dynamic」と分類（`system-prompt.ts:79`）
- 安定プレフィックスは全入力の SHA-256 でキャッシュ（`system-prompt.ts:121-141`）。バイト同一なら再レンダリングしない
- コメントに明記:
  > *"Channel/session-specific guidance lives below the cache boundary so large stable workspace context can remain a byte-identical prefix across turns."*（`system-prompt.ts:1288-1289`）

### なぜこれが my-discord-agent で成立しないか

| | openclaw | my-discord-agent |
|---|---|---|
| Agent のライフサイクル | **長生き**（ランタイム維持） | **毎リクエスト使い捨て**（`new Agent()` を都度生成） |
| システムプロンプト | ランタイムが保持 → バイト同一性 = キャッシュ効く | **毎回組み直し** → MEMORY 更新のたびプレフィックス崩壊 |

openclaw の方式は「ランタイムを維持するからこそシステムプロンプトのバイト同一性が保証できる」ことが前提。my-discord-agent の「使い捨て Agent」にはこの前提がない。**これが issue #117 で「初回のみ注入」が必要な根本理由**。

---

## 2. 「初回のみ」はどう実現しているか: 独自の custom 型

openclaw には標準の user/assistant/tool ではない **JSONL 専用の特殊型** がある。

### 型 1: `CustomEntry`（純粋マーカー、LLM 非表示）

```ts
// packages/agent-core/src/harness/session/session.ts:208
async appendCustomEntry(customType: string, data?: unknown): Promise<string>
// → { type: "custom", customType, data, ... }
```

- LLM 送信時に `convertToLlm` でフィルタされる
- 実例（4種）:

| customType | 用途 | 出典 |
|---|---|---|
| `openclaw:bootstrap-context:full` | **「初回 bootstrap 注入完了」マーカー**。継続ターンで再注入スキップの判定に使用 | `bootstrap-files.ts:36` |
| `openclaw.runtime-context` | ランタイム生成コンテキスト | `internal-runtime-context.ts:23` |
| `openclaw.cache-ttl` | プロンプトキャッシュ TTL 管理 | `cache-ttl.ts:17` |
| `openclaw.google-prompt-cache` | Google プロバイダーのキャッシュ参照 | `google-prompt-cache.ts:25` |

### 型 2: `CustomMessageEntry`（内容付き、表示制御可能）

```ts
// session.ts:220
async appendCustomMessageEntry(customType, content, display, details?)
```

- 本文 `content` を持てる、`display` で UI 表示制御
- `convertToLlm` 次第で LLM に渡す/渡さないを選択

### 仕組みの核心: `convertToLlm` で型を弾く

```ts
// packages/agent-core/src/harness/messages.ts:123
convertToLlm(messages): Message[] {
  return messages.map(m => {
    switch (m.role) {
      case "custom": return { role: "user", content, ... };  // user に変換して渡す
      // ...
    }
  });
}
```

openclaw は「初回だけ custom_message を user に変換して展開、マーカーを置く。2回目以降は `hasCompletedBootstrapTurn()` でマーカー有無を判定して再注入をスキップ」という制御をしている（`bootstrap-files.ts:78-149`）。

---

## 3. なぜ openclaw は独自型を作ったか: pi-agent-core をフォークした

### 決定的証拠: 両者は別パッケージ

| | pi-agent-core | openclaw |
|---|---|---|
| パッケージ名 | `@earendil-works/pi-agent-core` | `@openclaw/agent-core`（private, `0.0.0-private`） |
| 依存関係 | — | **pi-agent-core に依存していない** |
| ディレクトリ構造 | フラット | `harness/` 層を独自追加 |

openclaw の root `package.json` には `@earendil-works/pi-tui` はあるが `pi-agent-core` はない。

### 共通の先祖から分岐

両者の型定義コメントに `@mariozechner/agent` が登場:
- pi-agent-core `types.d.ts:256`: `declare module "@mariozechner/agent"`
- openclaw も同じコメント

→ **Mario Zechner 氏のオリジナル `agent` を祖先に持つが、別々に fork して独自進化させた**。

### openclaw がフォークで足した独自機能

`@openclaw/agent-core` が追加したのは **「ハーネス（harness）層」** 全体:

```
dist/harness/
├── agent-harness.ts       ← エージェント実行エンジン
├── session/
│   ├── jsonl-repo.ts      ← JSONL永続化
│   └── ...
├── compaction.ts          ← ★compaction
├── branch-summarization.ts
└── types.ts               ← 独自エントリ型
```

`harness/types.ts:454` で独自 `SessionTreeEntry` を定義:

```ts
export type SessionTreeEntry =
  | MessageEntry
  | CompactionEntry          // ★compaction
  | BranchSummaryEntry       // ★分岐サマリー
  | CustomEntry              // ★カスタムマーカー
  | CustomMessageEntry       // ★カスタムメッセージ
  | LabelEntry               // ★ラベル
  | LeafEntry                // ★ツリー葉
  | ...
```

**pi-agent-core にはこれらが 1 つもない。**

### 結論: フォークの理由

openclaw が独自型を作ったのは **「pi-agent-core が提供していない機能が必要だったから」**:

1. **JSONL 永続化とセッションツリー管理**（branch/leaf/label）→ pi-agent-core は永続化を持たない
2. **compaction**（長期セッションの履歴圧縮）→ pi-agent-core には `transformContext` という汎用フックはあるが compaction 専用型はない
3. **LLM に渡さないメタデータの保存**（bootstrap 完了マーカー等）→ これが `CustomEntry`

---

## 4. `@openclaw/agent-core` は使えるか: 使えない（プライベート）

| 項目 | 状態 |
|---|---|
| `"private": true` | ✅ |
| `"version": "0.0.0-private"` | ✅ |
| npm 公開 | ❌ 404 Not Found |
| openclaw 本体（`openclaw`）は公開 | ✅ `2026.6.6` |

→ **openclaw リポジトリ内部のモノレポワークスペース専用**。外部から `npm install` 不可。

使おうとすると `packages/agent-core/` をソースコピーして自前メンテするしかない = 実質「pi-agent-core をフォークして自前 harness 層を実装する」のと同義で、**最大の改修**になる。

---

## 5. my-discord-agent（`@earendil-works/pi-agent-core`）の能力確認

pi-agent-core には openclaw harness 層はないが、**コアの拡張ポイントは標準で存在する**:

| 能力 | あり/なし | 出典 |
|---|---|---|
| `convertToLlm`（AgentMessage[] → LLM Message[] 変換） | **あり** | `dist/types.d.ts:141` |
| `transformContext`（LLM 送信前のコンテキスト変形） | **あり** | `dist/types.d.ts:162` |
| `CustomAgentMessages` 拡張インターフェース | **あり** | `dist/types.d.ts:264-265` |
| `AgentMessage = Message \| CustomAgentMessages[...]` | **あり** | `dist/types.d.ts:271` |
| `appendCustomEntry`（openclaw 独自） | **なし**（別方法で同等可能） | — |
| compaction | **なし**（`transformContext` で自前実装が必要） | — |

`CustomAgentMessages` は declaration merging で拡張できる:

```ts
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    contextBootstrap: {
      role: "custom";
      customType: "bootstrap-context";
      content: string;
    };
  }
}
```

これを `convertToLlm` で制御すれば、openclaw の custom 型が実現したかった「LLM に渡すか渡さないかを制御できる独自メッセージ型」と **本質的に同じこと** が pi-agent-core 正統 API で可能。

---

## 6. 結論と方針

### 3 つの実装経路の比較

| 経路 | やること | 難易度 | 将来性 |
|---|---|---|---|
| **A: 現仕様書通り**（tool_use/tool_result ペア） | 自前 JSONL 書き込み + 初回判定 + フォールバック。プロバイダー別ペア整合性リスク | 中 | compaction 時に tool_result が圧縮され崩れる懸念 |
| **B: pi-agent-core 正統**（`CustomAgentMessages` + `convertToLlm`）⭐ | 独自メッセージ型を定義し、初回だけ user 展開、2回目以降スキップ | 低〜中 | `transformContext` で compaction 制御の土台になる |
| **C: openclaw 追随**（`@openclaw/agent-core` コピー） | harness 層をソースコピー、session.ts 全面置き換え | **高** | openclaw 資産流用可だがメンテ負荷大 |

### 推奨: 経路 B

理由:
1. issue #117 の目的は「初回注入」であって「compaction 導入」ではない。compaction は別 issue で独立検討すべき
2. `@openclaw/agent-core` コピーは compaction のためだけにセッション基盤を全置換 → 費用対効果不合致
3. pi-agent-core の `CustomAgentMessages` + `convertToLlm` は openclaw の custom 型と本質的に同じ。利点だけを軽量に得られる
4. session-logs skill は `role=="user"` のみ抽出するため、custom 型は自然に除外される（現仕様の tool_result 案と同じ利点）
5. プロバイダー互換性リスクなし（最終的に標準 user メッセージに変換される）

### 残る検証 1 点（→ 解決済み）

経路 B を進める前に唯一リスクだったのが **`src/agent/session.ts` の `appendMessage` / `loadMessages` が custom 型を JSONL に読み書きできるか**。
→ pi-agent-core 標準の `CustomMessage`（`role: "custom"`）はそのまま読み書きでき、session.ts は無改修で通った。方針確定。

---

## 7. 実装結果（PR #122）

経路 B を採用。ただし当初の `CustomAgentMessages` declaration merging（独自 role）ではなく、**pi-agent-core が標準提供する `CustomMessage`（`role: "custom"`）を `customType` で使い分ける**形に単純化した。実装は `src/sandbox/agent-runner.ts` に集約され、session.ts ほか周辺モジュールは無改修。

### AGENTS.md と MEMORY.md で扱いを分けた

調査時点では「AGENTS.md / MEMORY.md をまとめて初回注入」と捉えていたが、実装では役割の違いから 2 系統に分けた。

| customType | 対象 | 保存形式 | LLM への渡し方 |
|---|---|---|---|
| `agents-snapshot` | AGENTS.md | `role: "custom"`（JSONL に固定化） | **チャット履歴に乗せない**。`convertToLlm` で常に除外し、systemPrompt（system role）の組み立てにのみ使う |
| `memory-bootstrap` | MEMORY.md | `role: "custom"`（JSONL に固定化） | **最初の 1 件のみ `role: "user"` に展開** |

- **AGENTS.md は system role に残した**: 指示遵守の優先度維持のため。チャット履歴に降ろさず、初回スナップショットで固定化して 2 回目以降は再読み込みせず systemPrompt に再利用する。AGENTS.md がある場合は `DEFAULT_SYSTEM_PROMPT` を完全に置き換え、空の AGENTS.md はベースプロンプトのオプトアウトとして扱う。
- **MEMORY.md は user role に変換**: AGENTS.md（system）との二重注入を避けつつ会話履歴経由で届ける。`MEMORY_CHAR_LIMIT = 2000` の truncate は維持。

### convertToLlm は委譲ベースに

`defaultConvertToLlm` は agents-snapshot を除外し memory-bootstrap を user 展開する以外は、未知 role を素通しせず **pi-agent-core 標準の `convertToLlm` に委譲**する形にした（PR #122 の `63343c3` で素通し版から修正）。

### 空ファイル・並べ替えの非対称性対応

- ファイル不存在（`null`）と空文字（`""`）を区別し、空文字でもスナップショット/bootstrap を書き込む（書き込まないと毎ターン再読み込みし続ける）。
- bootstrap 系は `loadMessages()` 後に常に履歴の先頭へ並べ替える（旧形式セッションの移行で末尾追記されると LLM への見え方が非対称になりキャッシュも崩れるため）。

### 経緯メモ

開発途中では独自 role 名（`custom` → `prompt`）や `ContextBootstrapMessage` 型 alias を試したが、最終的に `agents-snapshot` / `memory-bootstrap` の 2 customType に収束した（コミット `d9ac56b` / `d796979` / `fe39dcb` 周辺）。

---

## 参考ファイル

- 実装: `src/sandbox/agent-runner.ts`（+ `src/sandbox/agent-runner.test.ts`）
- 実装仕様書: `docs/spec/initial-context-injection.md`
- 既存調査: `docs/research/why-pi-agent-core.md`, `docs/research/pi-agent-core-session.md`
- openclaw 参照クローン: `docs/clone/openclaw/`

---

*調査日: 2026-06-16 / 実装反映: 2026-06-17（PR #122）*
