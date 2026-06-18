# thinkingFormat 自動補正ロジックの完全廃止 設計ドキュメント

Issue: [#111 llama-cpp-qwen3などのプロバイダーいらない説](https://github.com/shin902/my-discord-agent/issues/111)

## 1. 背景

### 1.1 Issue #111 の提起

「`llama-cpp-qwen3` のような Qwen 系プロバイダーは不要ではないか」という提起。本文は「チャットテンプレートをまともに設定していなかった時代の遺物」と主張し、コメントは「チャットテンプレートの上書きはモデル実行時でないと効かない。リーズニングエフォートを消す方法をドキュメントに記載すべき」と修正案を提示。

### 1.2 調査で判明したこと

`llama-cpp-qwen3` という **固有のプロバイダー実装はコード上に存在しない**。

- `provider` は `z.string()` で任意文字列（`src/config/credential-proxy.ts:31`）。enum 制約なし。
- pi-ai の `KnownProvider` 一覧に `llama-cpp` / `llama-cpp-qwen3` は含まれない。
- 唯一プロバイダー名で分岐するコードが `src/agent/model.ts:28` の `resolveThinkingFormat`:

```ts
function resolveThinkingFormat(entry, baseUrl) {
  const format = entry.compat?.thinkingFormat;
  if (format === "qwen") {
    const provider = entry.provider.toLowerCase();
    if (provider.includes("llama-cpp")) return "qwen-chat-template";   // ← この分岐
    if (provider.includes("ollama") || new URL(baseUrl).port === "11434") {
      return "openrouter";
    }
  }
  if (format === "ollama") return "openrouter";   // ← この変換
  return format;
}
```

### 1.3 本質的な問題点

`provider.includes("llama-cpp")` で `qwen-chat-template` を選ぶのは **直交する2つの概念を名前で無理やり絡べている**。

- **`llama-cpp`** = バックエンドの種類（llama-server）。動かすモデルは Qwen とは限らない。
- **`qwen-chat-template`** = Qwen の思考制御 wire format（`chat_template_kwargs.enable_thinking`）。

「`llama-cpp` プロバイダーだから `qwen-chat-template`」という結びつけは本質的に不自然。プロバイダー名が任意文字列である以上、この魔法は命名規約に依存して脆い。

## 2. 現状のデータフローと落とし穴

### 2.1 全体の流れ

```
JSON config
  ↓ zod パース（credential-proxy.ts:61-80）
compat.thinkingFormat: "qwen" | "qwen-chat-template" | "ollama" | "openrouter" | "deepseek" | "zai" | "openai"
  ↓ resolveThinkingFormat（model.ts:21-40）  ← 抽象ラベルを具体値に変換するレイヤー
pi-ai の OpenAI compatible ストリーム
```

`resolveThinkingFormat` は2つの「抽象ラベル」を具体的な wire format に変換している:

| 抽象ラベル | 具体値 | 判定信号 |
|---|---|---|
| `"qwen"` | `"qwen-chat-template"` | プロバイダー名に `llama-cpp` を含む |
| `"qwen"` | `"openrouter"` | プロバイダー名に `ollama` を含む or ポート `11434` |
| `"qwen"` | `"qwen"`（そのまま） | 上記以外（vLLM/SGLang） |
| `"ollama"` | `"openrouter"` | 無条件 |

### 2.2 llama-cpp は設定修正だけで解決する

具体値を直接書けば最後の `return format` で素通り。既存コードは変換せずそのまま pi-ai に渡す。

- `config.example.json:72` は既に `"qwen-chat-template"` を直接指定しており、動作する。
- 実運用 `credential-proxy.json:43` の `"qwen"` を `"qwen-chat-template"` に書き換えれば、`model.ts:28` の分岐は無力化。
- つまり **設定修正だけで実質機能し、コード削除は仕上げ**。

### 2.3 Ollama には落とし穴がある

Ollama のマジックは **2つの役割** を同時に担っており、片方が具体値では再現できない:

```ts
// model.ts:70-90
const isOllama =
    originalFormat === "ollama" ||
    (originalFormat === "qwen" && resolvedFormat === "openrouter");

return {
  ...
  ...(isOllama ? {
      thinkingLevelMap: {
        off: "none",
        minimal: "low",
        xhigh: "high",
      },
    } : {}),
  ...
};
```

- `"ollama"`（抽象）を書く → format を `"openrouter"` に変換 **＋** `thinkingLevelMap` を付与。
- `"openrouter"`（具体）を直接書く → format は同じ **だが `thinkingLevelMap` が付かない**。

Ollama は `reasoning: { effort }` 形式を使うため effort レベルの値マッピングが必須。これが抽象ラベル `"ollama"` に紐付いているため、具体値 `"openrouter"` で置き換えると **マッピングが欠落** する。

**このため、llama-cpp と異なり、Ollama は「設定修正だけ」では完全には置き換えられない。** 設定フィールドを追加して `thinkingLevelMap` を明示書きできるようにする必要がある。

## 3. 採用方針: 完全統一（config フィールド追加）

自動補正ロジックを **全廃** し、`thinkingFormat` と `thinkingLevelMap` を **config から直接指定** する方針を採用する。

### 3.1 採用理由

1. **一貫性**: llama-cpp だけ消して Ollama の魔法を残すと、似たような脆いコードが中途半端に残る。全部統一した方が保守性が高い。
2. **「設定が素直で読める」ことの価値**: 自動検出の便利さよりも、pi-ai に渡る値が config に書いてある値と一致する方がデバッグしやすい。
3. **Issue #111 コメントの方向性と整合**: 「リーズニングエフォートを消す方法をドキュメントに記載」という方向は、直接指定を前提にした説明で最もスッキリ書ける。
4. **トレードオフの許容**: 設定を書く側が「自分のバックエンドはどの format か」を知る必要はあるが、pi-ai が定義する enum 値から選ぶだけなので学習コストは低い。

### 3.2 却下した代替案

| 案 | 却下理由 |
|---|---|
| llama-cpp 行のみ削除（最小変更） | Ollama 系に同じ脆さが残り、Issue の指摘が部分的にしか解決されない。 |
| ドキュメント整備のみ | コードの不自然さを残す。Issue 本文の「いらない説」に直接答えない。 |
| `backend: "llama-cpp" \| "ollama" \| "vllm"` のような専用判定フィールド追加 | フィールドを増やす点では採用案と同じだが、抽象レイヤーを維持する分、複雑さが残る。直接指定の方がシンプル。 |

## 4. 設計

### 4.1 スキーマ変更（`src/config/credential-proxy.ts`）

#### 廃止する enum 値

`thinkingFormat` から **抽象ラベルを削除**:

```diff
   compat: z.object({
     thinkingFormat: z.enum([
       "openai",
       "openrouter",
       "deepseek",
       "zai",
-      "qwen",
       "qwen-chat-template",
-      "ollama",
     ]).optional(),
     // "qwen"（vLLM/SGLang 等の enable_thinking: boolean 形式）は
     // 現状利用箇所がないため削除。必要になった時点で具体値として再追加する。
+    // thinkingLevel をサーバー固有の effort 値にマッピングする。
+    // Ollama の OpenAI 互換 API（reasoning.effort）など、
+    // pi-ai のデフォルトマップと異なる値体系を使うサーバーで指定する。
+    thinkingLevelMap: z.object({
+      off: z.string(),
+      minimal: z.string().optional(),
+      low: z.string().optional(),
+      medium: z.string().optional(),
+      high: z.string().optional(),
+      xhigh: z.string().optional(),
+    }).optional(),
     requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
   }).optional(),
```

**残す値の意味（すべて pi-ai が解釈する具体 wire format）**:

| 値 | 対象サーバー | wire 形式 |
|---|---|---|
| `"qwen-chat-template"` | llama.cpp / llama-cpp-python | `chat_template_kwargs.enable_thinking` + `preserve_thinking` |
| `"openrouter"` | Ollama OpenAI 互換 / OpenRouter | `reasoning.effort` |
| `"deepseek"` | DeepSeek 互換 | `thinking.type: enabled/disabled` |
| `"zai"` | ZAI | （pi-ai 定義に従う） |
| `"openai"` | OpenAI 標準 | thinking フィールドを送らない |

`"qwen"` / `"ollama"` は **抽象ラベル廃止**。pi-ai の enum にも元々含まれていない独自拡張だったため、削除しても pi-ai 側への影響はない。

### 4.2 `resolveThinkingFormat` の廃止（`src/agent/model.ts`）

関数ごと削除。`createCustomModel` はパースされた `thinkingFormat` をそのまま使う:

```diff
 function createCustomModel(...) {
   const api = entry.api ?? "openai-completions";
-  const resolvedFormat =
-    api === "openai-completions"
-      ? resolveThinkingFormat(entry, baseUrl)
-      : undefined;
+  const thinkingFormat = entry.compat?.thinkingFormat;
   const compat =
-    entry.reasoning !== false && entry.compat && resolvedFormat !== undefined
+    entry.reasoning !== false && entry.compat && thinkingFormat !== undefined
       ? ({
           ...entry.compat,
-          thinkingFormat: resolvedFormat,
+          thinkingFormat,
         } as Model<"openai-completions">["compat"])
       : undefined;
-  const originalFormat = entry.compat?.thinkingFormat;
-  const isOllama =
-    originalFormat === "ollama" ||
-    (originalFormat === "qwen" && resolvedFormat === "openrouter");
   return {
     ...
-    ...(isOllama ? { thinkingLevelMap: { off: "none", minimal: "low", xhigh: "high" } } : {}),
+    ...(entry.compat?.thinkingLevelMap ? { thinkingLevelMap: entry.compat.thinkingLevelMap } : {}),
     ...
   };
 }
```

`baseUrl` 引数は `resolveThinkingFormat` 専用だったため `createCustomModel` の引数からも削除可能（要・依存確認）。

### 4.3 バリデーション（オプション・推奨）

廃止した enum 値（`"qwen"` / `"ollama"`）を書いた場合、zod の enum エラーで弾かれる。エラーメッセージを親切にするため、カスタムメッセージか refine を追加:

```ts
thinkingFormat: z.enum([...], {
  errorMap: (issue, ctx) => {
    if (issue.code === "invalid_enum_value") {
      return { message: "thinkingFormat は pi-ai が解釈する具体値を直接指定してください（\"qwen\"/\"ollama\" の抽象ラベルは廃止されました）" };
    }
    return { message: ctx.defaultError };
  },
}),
```

### 4.4 config ファイルの修正

#### `config/config.example.json`

```diff
     {
       "provider": "llama-cpp-qwen3",
       "baseUrl": "http://localhost:8080/v1",
       "api": "openai-completions",
       "contextWindow": 65536,
       "maxTokens": 4096,
-      "compat": { "thinkingFormat": "qwen-chat-template" },
+      "compat": { "thinkingFormat": "qwen-chat-template" },
       ...
     },
     {
       "provider": "ollama-qwen3",
       "baseUrl": "http://localhost:11434/v1",
       "api": "openai-completions",
       "contextWindow": 65536,
       "maxTokens": 4096,
-      "compat": { "thinkingFormat": "ollama" }
+      "compat": {
+        "thinkingFormat": "openrouter",
+        "thinkingLevelMap": {
+          "off": "none",
+          "minimal": "low",
+          "xhigh": "high"
+        }
+      }
     },
```

llama-cpp-qwen3 は変更なし（既に直接指定）。ollama-qwen3 は `"ollama"` → `"openrouter"` + `thinkingLevelMap` 明示。

#### `config/credential-proxy.json`（実運用、gitignored）

```diff
     {
       "provider": "llama-cpp-qwen3",
       "baseUrl": "http://192.168.40.65:8080/v1",
       "api": "openai-completions",
       "contextWindow": 65536,
       "maxTokens": 4096,
-      "compat": { "thinkingFormat": "qwen" }
+      "compat": { "thinkingFormat": "qwen-chat-template" }
     },
     {
       "provider": "ollama-qwen3",
       "baseUrl": "http://192.168.40.13:11434/v1",
       "api": "openai-completions",
-      "compat": { "thinkingFormat": "ollama" }
+      "compat": {
+        "thinkingFormat": "openrouter",
+        "thinkingLevelMap": { "off": "none", "minimal": "low", "xhigh": "high" }
+      }
     },
```

### 4.5 テスト修正（`src/agent/model.test.ts`）

**削除するテスト**:
- `:165-183` 「llama-cpp の qwen 互換設定は chat_template_kwargs 形式に補正する」
- `:185-209` 「Ollama の qwen 互換設定は reasoning.effort 形式に補正する」
- `:211-232` 「vLLM 等は 'qwen' のまま返す」
- `:301-324` 「ポート 11434 のみで Ollama を検出し thinkingLevelMap を付与する」

**追加するテスト**:
- `thinkingLevelMap` を config に書いた場合、それが `model.thinkingLevelMap` にそのまま渡ることを検証。
- `thinkingLevelMap` 省略時は `model.thinkingLevelMap` が `undefined` になることを検証。
- `thinkingFormat` に直接値（`"qwen-chat-template"` / `"openrouter"` 等）を書いた場合、変換されずそのまま `model.compat.thinkingFormat` になることを検証（既存 `:144-163` 等で概ねカバー、整理のみ）。

### 4.6 ドキュメント修正（`docs/config/credential-proxy.md`）

#### `compat` テーブル（`:133-148`）

`thinkingFormat` の表を全面書き換え。抽象ラベル列を削除し、具体値のみ:

| 値 | 対象サーバー | wire 形式 |
|---|---|---|
| `"qwen-chat-template"` | llama.cpp（`--jinja` 必須） | `chat_template_kwargs.enable_thinking` + `preserve_thinking` |
| `"openrouter"` | Ollama（v0.9.0+）/ OpenRouter / その他 `reasoning.effort` 系 | `reasoning.effort` |
| `"deepseek"` | DeepSeek 互換 | `thinking.type` |
| `"zai"` | ZAI | pi-ai 定義 |
| `"openai"` | OpenAI 標準（デフォルト） | thinking 送信なし |

`thinkingLevelMap` フィールドを新規追加:

```markdown
### `compat.thinkingLevelMap`

`thinkingLevel` をサーバー固有の effort 値にマッピングする。
Ollama の OpenAI 互換 API など、`reasoning.effort` の値体系が
pi-ai のデフォルトと異なるサーバーで指定する。

```json
{
  "compat": {
    "thinkingFormat": "openrouter",
    "thinkingLevelMap": { "off": "none", "minimal": "low", "xhigh": "high" }
  }
}
```

省略時は pi-ai のデフォルトマップが使われる（`openrouter` なら
`off`/`minimal`/`low`/`medium`/`high`/`xhigh` がそのまま effort 値になる）。
```

#### 自動補正の記述を削除

- `:143` の「ただし `provider` が `llama-cpp` なら `"qwen-chat-template"`、`ollama` なら `"ollama"` 相当に自動補正」の記述を削除。
- `:228` の「`"llama-cpp"` は単なる識別子…」の注意書きは、直接指定を前提にすれば自明になるため簡略化。
- `:278` の「`"qwen"` の自動補正はプロバイダー名に `ollama` が含まれるか、ポートが `11434` の場合にのみ機能」という注意書きは削除（自動補正そのものがなくなる）。

#### 「直接指定」を前提にした構成へ

Issue #111 コメントの「リーズニングエフォートを消す方法をドキュメントに記載」に応える形で、以下を明記:

- thinking OFF の典型パターン（llama.cpp + Qwen3）→ `thinkingFormat: "qwen-chat-template"` + `thinkingLevel: "off"`
- thinking OFF の典型パターン（Ollama + Qwen3）→ `thinkingFormat: "openrouter"` + `thinkingLevelMap` + `thinkingLevel: "off"`
- いずれも「値は pi-ai が解釈する具体 wire format を直接書く」という原則を統一。

## 5. 移行・後方互換性

### 5.1 破壊的変更

`"qwen"` / `"ollama"` を `thinkingFormat` に指定していた既存 config は **起動時に zod バリデーションエラーで弾かれる**（明確な fail-fast）。

### 5.2 移行手順

| 旧値 | 新値 | 備考 |
|---|---|---|
| `"qwen"`（llama.cpp 向け） | `"qwen-chat-template"` | |
| `"qwen"`（Ollama 向け） | `"openrouter"` + `thinkingLevelMap` | ポート/名前で暗黙に Ollama 判定していた分を明示 |
| `"qwen"`（vLLM/SGLang） | 非対応（enum から削除、5.3 参照） | 現状利用箇所なし。必要になれば再追加 |
| `"ollama"` | `"openrouter"` + `thinkingLevelMap` | |

### 5.3 決定: `"qwen"` は enum から削除する

`"qwen"` は元々「pi-ai が `enable_thinking: boolean` として処理する」形式だった（`model.ts:32-33` のコメント）。これを enum から削除すると、vLLM/SGLang 等、`enable_thinking` を使うサーバー向けの指定がなくなる。

選択肢:
1. `"qwen"` を enum に残す（抽象ラベルではなく、pi-ai が解釈する具体値として位置づける）。
2. **`"qwen"` を削除する。**

**採用: 案2。**

- 実運用 `config/credential-proxy.json:43` の唯一の `"qwen"` 利用箇所は `provider: "llama-cpp-qwen3"`（llama.cpp 向け）であり、`"qwen-chat-template"` への書き換え対象（4.4 節）。vLLM/SGLang を使っている設定は現状存在しない。
- 将来 vLLM/SGLang 向けに `enable_thinking: boolean` 形式が必要になった時点で、改めて具体値として `"qwen"` を追加すればよい（YAGNI）。今ない需要のために enum に残すと、「抽象ラベルを全廃した」という本設計の意図と矛盾し、`"qwen"` が具体値なのか抽象ラベルの名残なのか紛らわしさが残る。

## 6. 影響範囲サマリ

| ファイル | 変更内容 |
|---|---|
| `src/config/credential-proxy.ts` | enum 調整（`"qwen"` / `"ollama"` 削除）、`thinkingLevelMap` スキーマ追加 |
| `src/agent/model.ts` | `resolveThinkingFormat` 関数ごと削除、`createCustomModel` を直接参照に変更 |
| `src/agent/model.test.ts` | 自動補正系テスト削除、直接指定・`thinkingLevelMap` テスト追加 |
| `config/config.example.json` | `ollama-qwen3` エントリを直接指定に書き換え |
| `config/credential-proxy.json`（gitignored） | 実運用エントリを直接指定に書き換え |
| `docs/config/credential-proxy.md` | `thinkingFormat` 表整理、`thinkingLevelMap` 追記、自動補正の記述削除 |

## 7. 実装の進め方（着手時）

1. スキーマ変更（`credential-proxy.ts`）→ テストで型チェック。
2. `model.ts` の `resolveThinkingFormat` 削除 → テスト修正。
3. config ファイル（example + 実運用）書き換え。
4. ドキュメント更新。
5. ローカルで llama.cpp / Ollama 両方の実機確認（thinking ON/OFF 切り替え）。
6. PR 作成、Issue #111 にリンクして close。

## 8. Issue #111 への回答

- **本文「プロバイダーいらない説」**: プロバイダー実装は元々存在しない（任意文字列）。削除対象なのは `resolveThinkingFormat` の自動補正ロジック。本設計で対応。
- **コメント「ドキュメント整備」**: thinkingFormat 直接指定を前提にしたドキュメント整理を含む。本設計で対応。
- **`provider.includes("llama-cpp")` の不自然さ**: 根本的に解消。プロバイダー名で wire format を決めない設計に統一。
