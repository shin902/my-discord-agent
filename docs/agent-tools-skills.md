# エージェントのツールとスキル

エージェントが使えるツールとスキルの概要。グループ設定（`config/groups.json` の `groups[]`）と `AGENTS.md` でどれを有効にするかを制御する。

## ツール

エージェントに渡す MCP ツール群。`groups[].tools` フィールドで指定する。

| ツール名 | 概要 |
|---------|------|
| `bash` | サンドボックス内でシェルコマンドを実行 |
| `agent-reach` | URLを自動判定してコンテンツを取得。YouTube・Reddit・GitHub・RSS・X/Twitter・一般ウェブに対応。整形済みテキストをツール結果として直接返す |
| `read` | ワークスペース内のファイルを読み込む |
| `write` | ワークスペース内にファイルを書き込む |
| `edit` | ワークスペース内のファイルを文字列置換で編集する |
| `list` | ワークスペース内のディレクトリ一覧を取得する |
| `glob` | glob パターンでファイルを検索する |
| `grep` | 正規表現でファイル内を検索する |
| `list-issues` | GitHub リポジトリの Issue 一覧を取得（Pull Request は除外） |
| `read-issue` | GitHub Issue の本文とメタ情報を取得 |
| `read-pull-request` | GitHub Pull Request の本文とメタ情報（base/head を含む）を Markdown で返す |
| `list-issue-comments` | GitHub Issue の全コメントを取得し、作者・日時・本文を Markdown で返す |
| `list-pull-request-comments` | GitHub Pull Request の会話コメント・レビュー・インラインコメントを全件取得し、Markdown で返す |
| `comment-issue` | GitHub Issue に Markdown コメントを投稿 |
| `clone-repository` | Credential Proxy 経由で GitHub リポジトリを clone（`directory` 省略時は `/tmp/{repo}`、指定時も `/tmp` 基準の相対パスに限定。`depth` 省略時は全履歴、指定時のみ shallow clone） |
| `browserless-search` | ウェブ検索を実行して結果（JSON）を返す |
| `browserless-function` | Puppeteer コードをブラウザで実行する |
| `tavily-search` | Tavily Search API でウェブ検索を実行。最新情報の取得やファクトチェックに使う |
| `tavily-extract` | Tavily Extract API で指定URLのページ本文を抽出する |
| `tavily-crawl` | Tavily Crawl API でサイト内をクロールし各ページの本文を取得する |
| `tavily-map` | Tavily Map API でサイト内のURL構造をマッピングする |

**注意:** `webfetch` は削除済み。URLの内容取得には`agent-reach`ツールを使う。

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

**代替手段:** 一般的なウェブコンテンツ取得は `agent-reach` ツール（`r.jina.ai` 経由）を使う。Jina Reader はマークダウン変換済みの本文のみを返すため、HTML 全文よりも大幅にトークン数が少ない。

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
  "allowMention": true,
  "toolLogArgs": true
}
```

> **注意:** `bash` ツールは `echo $OPENCODE_API_KEY` のようなコマンドを引数に含む場合がある。
> `toolLogArgs: true` にする場合は Discord チャンネルの閲覧者を考慮すること。

## スキル

`groups/{name}/SKILLS/{skill}/SKILL.md` に配置するプロンプトテンプレート。通常はシステムプロンプトの `<available_skills>` 一覧として渡され、LLM が必要に応じて `read` ツールで読み込んで使う（自律判断）。

スキルと専用ツールは独立した実行経路として扱う。スキルは `bash` と同梱スクリプトを利用でき、標準出力の直接利用だけでなくファイルへのリダイレクトなど、用途に応じた柔軟なワークフローを提供する。一方、専用ツールは `bash` を許可したくない不特定多数向けのボットでも、対象機能だけを安全に許可するために使う。スキルを専用ツールの使い方だけを説明するドキュメントにはしない。

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

インターネット情報収集スキル。同梱の `agent-reach.sh` を `bash` から実行し、取得結果を標準出力で直接利用したり、必要に応じてファイルへ保存したりできる。`agent-reach`ツールとは独立した実行経路であり、スキルからツールは呼び出さない。

`bash`を許可したくない不特定多数向けのボットでは、スキルを有効にせず、専用の`agent-reach`ツールだけを`groups[].tools`へ追加する。

| 対象 | 内部の取得経路 |
|------|----------------|
| ウェブページ | Jina Reader (`r.jina.ai`) |
| YouTube | `yt-dlp` |
| GitHub | GitHub REST API |
| Reddit | Credential Proxy経由のJSON API |
| RSS | `feedparser` |
| X/Twitter | FxTwitter (`api.fxtwitter.com`) のみ（Credential Proxy へのフォールバックなし） |

スキルは同梱のシェルスクリプトを使用する。専用ツール側はシェルスクリプトに依存せず、`bash`を許可しない構成でも単独で動作する。両者の用途と実行経路は独立している。

#### 入力・出力・エラーの parity 契約

これは2つの実装を同じコードにするための契約ではなく、利用者から見える挙動を揃えるための基準である。

- **入力:** どちらも1つの絶対URLを受け取り、`http` / `https` 以外は拒否する。fragment は取得先へ渡さず、リソース指定や署名に使われる可能性がある query は正規化時に削除せず、サービス固有の取得処理で扱う。正規化後のURLを同じサービス判定表（Web、YouTube、GitHub repository、Reddit、RSS、X post）で分類する。X Article の直リンクは、記事付き post の `/status/...` URLを案内する入力エラーとする。
- **整形済み出力:** 取得本文の意味とサービス別フォーマットを共通契約とする。Web は reader 本文、YouTube・GitHub・Reddit・X は Markdown、RSS は feedparser が生成する最大20件の JSON 配列テキストを返す。X の出力には外部コンテンツへの注意書きを含める。スキルは整形済みテキストだけを stdout に出し、必要なら呼び出し側が `>` で保存できる。ツールは同じ本文を `content[0].text` に返し、正規化済みURLとサービス名を `details` に付ける（ツールはワークスペースへ結果ファイルを残さない）。決定的な入力の本文は、共有 fixture で両経路の内容一致を固定する（スクリプトの stdout に付く transport 用の末尾改行は除く）。
- **エラー:** 入力拒否・依存コマンド不足・Credential Proxy 設定不足・上流HTTP/JSON/取得失敗は、本文として成功扱いにせずエラーにする。ツールは例外を throw し、スキルは非0終了して診断を stderr に出す。インターフェース上の envelope（例外と終了コード/stderr）は異なるが、エラーのカテゴリと機密情報を漏らさない診断内容は共通に保つ。

共有 fixture は `src/tools/__fixtures__/agent-reach/parity-cases.json` に置き、URL正規化・サービス判定・決定的なX post本文・代表的なエラーを `src/tools/agent-reach.test.ts` と `src/tools/agent-reach-shell.test.ts` の両方から検証する。今後この契約を変更する issue では、まず fixture と両方のテストを更新するが、スキルから TypeScript ツールを呼び出す実装には変更しない。

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

`wiki-ingest`・`wiki-query`・`wiki-lint` は `wiki-setup` 実行後に `/workspace/SKILLS/` へ配置される。`groups.json` の `skills` フィールドを**省略**しているグループではロードされない。利用するには `"wiki-ingest"` 等を明示的に追加するか、全スキルを許可する場合だけ `"skills": "*"` を指定する（`skills: []` のままでは読み込まれない）。

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
