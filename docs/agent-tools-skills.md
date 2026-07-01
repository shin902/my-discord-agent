# エージェントのツールとスキル

エージェントが使えるツールとスキルの概要。グループ設定（`config/groups.json` の `groups[]`）と `AGENTS.md` でどれを有効にするかを制御する。

## ツール

エージェントに渡す MCP ツール群。`groups[].tools` フィールドで指定する。

| ツール名 | 概要 |
|---------|------|
| `bash` | サンドボックス内でシェルコマンドを実行。`agent-reach` スキルで使う CLI ツール群はここ経由で動く |
| `agent-reach` | URLを自動判定してコンテンツを取得。YouTube・Reddit・GitHub・RSS・一般ウェブに対応。取得したコンテンツ（Markdown）はツールコール結果として直接返される（ファイル保存はしない） |
| `read` | ワークスペース内のファイルを読み込む |
| `write` | ワークスペース内にファイルを書き込む |
| `edit` | ワークスペース内のファイルを文字列置換で編集する |
| `list` | ワークスペース内のディレクトリ一覧を取得する |
| `glob` | glob パターンでファイルを検索する |
| `grep` | 正規表現でファイル内を検索する |
| `browserless-search` | ウェブ検索を実行して結果（JSON）を返す |
| `browserless-function` | Puppeteer コードをブラウザで実行する |
| `tavily-search` | Tavily Search API でウェブ検索を実行。最新情報の取得やファクトチェックに使う |
| `tavily-extract` | Tavily Extract API で指定URLのページ本文を抽出する |
| `tavily-crawl` | Tavily Crawl API でサイト内をクロールし各ページの本文を取得する |
| `tavily-map` | Tavily Map API でサイト内のURL構造をマッピングする |

**注意:** `webfetch` は削除済み。ウェブアクセスはすべて `agent-reach` または `bash` 経由で行う。

### Browserless ツールの使用制限

`src/tools/browserless.ts` が提供するツールのうち、**以下の2つはローカル LLM では使用禁止**とする。

| ツール | 理由 |
|--------|------|
| `browserless-content` | JavaScript 描画後の HTML 全文をそのままコンテキストに流し込む。重いサイトでは数十万トークン規模になりコンテキスト爆発する |
| `browserless-smart-scrape` | JS ブロック回避の自動フォールバックが働くと内部的に `content` 相当の処理に落ちる。同様にコンテキストオーバーが発生する |

**使って良いもの（ローカル LLM でも安全）:**

| ツール | 理由 |
|--------|------|
| `browserless-search` | 検索結果（件数・スニペット）のみ返す。出力サイズが予測可能 |
| `browserless-function` | Puppeteer コードで取得対象を自分で絞り込めるため、返却サイズをコントロールできる |

**代替手段:** 一般的なウェブコンテンツ取得は `agent-reach` スキル（`r.jina.ai` 経由）を使う。Jina Reader はマークダウン変換済みの本文のみを返すため、HTML 全文よりも大幅にトークン数が少ない。

## Discord へのツールコール通知

エージェントがツールを実行するたびに Discord チャンネルへ通知が届く（`🔧 \`toolName\``）。

### 引数の表示設定

`groups[].toolLogArgs` で引数を表示するかどうかをグループごとに設定できる。

| 値 | 挙動 |
|----|------|
| `false`（省略時デフォルト） | ツール名のみ表示。引数は送信しない（セキュリティ上の安全側） |
| `true` | ツール名 + 引数 JSON を表示（先頭 300 文字で切り詰め） |

```json
{
  "model": { "provider": "zai", "modelId": "glm-4.7-flash" },
  "tools": ["bash", "read", "write"],
  "autoReply": true,
  "toolLogArgs": true
}
```

> **注意:** `bash` ツールは `echo $OPENCODE_API_KEY` のようなコマンドを引数に含む場合がある。
> `toolLogArgs: true` にする場合は Discord チャンネルの閲覧者を考慮すること。

## スキル

`groups/{name}/SKILLS/{skill}/SKILL.md` に配置するプロンプトテンプレート。通常はシステムプロンプトの `<available_skills>` 一覧として渡され、LLM が必要に応じて `read` ツールで読み込んで使う（自律判断）。

### スキルの明示的実行（`./command`）

LLM の自律判断を待たず、ユーザーが特定のスキルを確実に実行させたい場合は次の形式で発火できる。

```
./command スキル名 [追加指示]
```

| 例 | 動作 |
|----|------|
| `./command agent-reach https://example.com を要約して` | `agent-reach` の `SKILL.md` 本文をプロンプトに強制注入し、追加指示と共に実行させる |
| `./command session-logs` | 追加指示なしで `session-logs` を実行させる |

**仕組み（`src/skills/command.ts` / `src/sandbox/agent-runner.ts`）:**

- `parseSkillCommand()` がメッセージ先頭の `./command スキル名` パターンを解析する
- 指定されたスキル名がグループの `skills` 許可リスト（`groups/{name}/group.json`）に存在しない場合、LLM を呼ばずに利用可能なスキル一覧をエラーとして即時返信する
- 存在する場合、`SKILL.md` のフロントマターを除いた本文を「このスキルの手順に従って実行してください」という指示文に整形し、`role: "custom"` / `customType: "skill-invocation"` の専用メッセージとして組み立てる
- ユーザーの生発言（`./command スキル名 ...`）はそのまま `role: "user"` メッセージとして保持し、上記の skill-invocation メッセージと**2件セット**で `agent.prompt()` に渡す。両方とも JSONL セッションに永続化されるため、履歴上で「ユーザーが何を打ったか」と「LLM に渡った実行指示」を区別できる
- `defaultConvertToLlm()` が skill-invocation メッセージを `user` ロールとして LLM 送信用メッセージに変換する（`<available_skills>` 経由の自律判断とは異なり、必ず該当スキルの手順が実行される）。`memory-bootstrap` と異なり1セッション内に複数件存在しうるため、出現するたびに変換する（最初の1件だけに絞るデデュープはしない）

### agent-reach

**場所:** `templates/SKILLS/agent-reach/SKILL.md`

インターネット情報収集スキル。サンドボックスの bash ツール経由で以下の CLI を使う。

| 対象 | ツール | 備考 |
|------|--------|------|
| ウェブページ | `curl` + Jina Reader (`r.jina.ai`) | JS依存サイトも対応 |
| YouTube | `curl` (oEmbed) / `yt-dlp` | 基本情報は oEmbed、詳細・字幕は yt-dlp |
| GitHub | `gh` CLI | public リポジトリは認証不要 |
| Reddit | `curl` (JSON API) | 認証不要 |
| RSS | `feedparser` (Python) | 認証不要 |

これらの CLI はサンドボックスの Docker イメージ（`Dockerfile`）に焼き込まれている。

**テンプレートを更新した場合の注意:** `templates/SKILLS/` を変更しても、すでに各グループにコピーされた `groups/{name}/SKILLS/` は自動更新されない。テンプレートの変更を反映するには、対象グループの古いスキルフォルダを削除してから再コピーすること。

```bash
rm -rf groups/{name}/SKILLS/agent-reach
cp -r templates/SKILLS/agent-reach groups/{name}/SKILLS/
```

### session-logs

**場所:** `templates/SKILLS/session-logs/SKILL.md`

自分自身の過去のセッションログ(`/sessions/*/*.jsonl`)を jq/grep で検索・集計するスキル。`MEMORY.md` に無い過去の会話について聞かれたときに使う。PR #87 のセッションマウント絞り込みにより、自グループのログのみが見える。

### 日次記録・週次MEMORY.md更新(memory-daily / memory-weekly cron)

専用スキルは設けず、`config/cron.json` に prompt-only ジョブを登録し、`session-logs` スキルの使い方と出力フォーマットをそのまま `prompt` に書く(`cron.example.json` 参照)。出力フォーマットは個人の好みに依存するため、共有テンプレートにはしない。

導入するグループには `session-logs` を `skills` に追加し、`bash` / `write` / `edit` ツールを有効にする。

### interest-profile

**場所:** `templates/SKILLS/interest-profile/SKILL.md`

会話履歴からユーザーの興味プロファイルを抽出・蓄積し `INTERESTS.md`（プロジェクトルート）を生成・更新するスキル。`sync`（履歴差分を分析してシグナルを `data/interests/interest-log.jsonl` に追記し再生成）と `show`（既存の `INTERESTS.md` を表示するだけ）の2モードを持つ。cron等からの自律実行時はユーザーへの確認を行わない設計。

### last30days

**場所:** `templates/SKILLS/last30days/SKILL.md`

指定トピックについて、HackerNews・Reddit・GitHub（いずれもAPIキー不要）から過去30日間の議論・反応を横断的に収集し、注目トピック・プラットフォーム別サマリー・センチメント・注目リンクの形式で集約するスキル。

### md2html

**場所:** `templates/SKILLS/md2html/SKILL.md`

Markdownファイルを、CDN/外部JS依存なしの単一HTMLファイルに変換するスキル。`pip install md2html-phuker` の `md2html` コマンドを使う。ダークテーマやサイドバー目次付きスタイルにも対応。

### wiki系スキル（wiki-setup / wiki-ingest / wiki-query / wiki-lint / wiki-search / wiki-search-fts）

LLMが維持する個人用wikiを `raw/`（不変ソース）→ `wiki/`（LLM所有のMarkdown）→ `AGENTS.md`（スキーマ）の三層構造で運用するためのスキル群。

#### スキルの配置方針

`wiki-ingest`・`wiki-query`・`wiki-lint` は `wiki-setup` にバンドルされており、`templates/SKILLS/` には独立して存在しない。`wiki-setup` 実行時のヒアリングで確定したディレクトリ名が `setup.sh` によってスキルに焼き込まれ、`/workspace/SKILLS/` へコピーされる。

`wiki-ingest`・`wiki-query`・`wiki-lint` は `wiki-setup` 実行後に `/workspace/SKILLS/` へ配置される。`groups.json` の `skills` フィールドを**省略**しているグループでは自動でロードされる。`skills` フィールドを明示しているグループでは `"wiki-ingest"` 等を追加する必要がある（`skills: []` のままでは読み込まれない）。

| スキル | 場所 | 役割 |
|--------|------|------|
| `wiki-setup` | `templates/SKILLS/wiki-setup/` | wikiを初期構築する一回限りの足場作り。ヒアリング後に `setup.sh` でwiki-ingest/query/lintをインストールする |
| `wiki-ingest` | `wiki-setup/SKILLS/wiki-ingest/`（テンプレート） | 新しいソースを読み込み、要約してソースページを作成し、関連ページ・index・logに反映する |
| `wiki-query` | `wiki-setup/SKILLS/wiki-query/`（テンプレート） | wikiに基づいて出典付きで質問に回答し、永続的価値のある回答は新しいページとして書き戻す |
| `wiki-lint` | `wiki-setup/SKILLS/wiki-lint/`（テンプレート） | 孤立ページ・リンク切れ・frontmatter欠落・矛盾などを検出し、安全な修正を適用する |
| `wiki-search` | `templates/SKILLS/wiki-search/` | 外部依存なしの自前TFスコアリングによる軽量フルテキスト検索（数百ページ程度まで） |
| `wiki-search-fts` | `templates/SKILLS/wiki-search-fts/` | SQLite FTS5（BM25ランキング）による検索。`wiki-search`が不十分になった大規模wiki向けの移行先 |

### finance系スキル（finance-setup / finance）

`/workspace/finance.db`（グループの実体は `groups/{name}/finance.db`）のSQLiteで収支・サブスクリプションを管理するスキル群。

| スキル | 場所 | 役割 |
|--------|------|------|
| `finance-setup` | `templates/SKILLS/finance-setup/` | `transactions`（収支）・`subscriptions`（サブスク）テーブルを作成する一回限りの初期化。既存DBがあれば上書きしない |
| `finance` | `templates/SKILLS/finance/` | 収支の記録・照会、サブスクの登録・照会・更新・解約を `sqlite3` コマンド直叩きで行う |

**スキーマ:**

```sql
transactions (id, date, amount, category, description)
subscriptions (id, name, amount, cycle, next_date, category, active)
```

`amount` は収入が正・支出が負（円の整数）。`cycle` は `monthly` / `yearly` / `weekly`。カテゴリはユーザー入力をそのまま使い正規化しない。

**cron連携（`src/cron/jobs/`）:**

| ジョブ | 概要 |
|--------|------|
| `finance-monthly.ts` | 月次の収支サマリー（収入・支出・カテゴリ別支出・サブスク月額換算）をDiscordに送信 |
| `finance-subscription-reminder.ts` | `daysAhead`（デフォルト7日）以内に更新日を迎えるサブスクを通知 |
| `_finance-db.ts` | 上記2ジョブが共有する `resolveFinanceDbPath(groupName)`。`groups/{groupName}/finance.db` を解決し、`groupName` のディレクトリトラバーサル防止とDB未作成時のエラー化を行う |

両ジョブとも `ctx.channelId` / `ctx.groupName` が必須で、DBは読み取り専用（`readonly: true`）で開く。導入には `config/cron.json` にジョブ定義を追加し、対象グループで事前に `finance-setup` を実行しておく必要がある。
