# エージェントのツールとスキル

エージェントが使えるツールとスキルの概要。グループ設定（`groups/{name}/group.json`）と `AGENTS.md` でどれを有効にするかを制御する。

## ツール

エージェントに渡す MCP ツール群。`group.json` の `tools` フィールドで指定する。

| ツール名 | 概要 |
|---------|------|
| `bash` | サンドボックス内でシェルコマンドを実行。`agent-reach` スキルで使う CLI ツール群はここ経由で動く |
| `agent-reach` | URLを自動判定してコンテンツを取得。YouTube・Reddit・GitHub・RSS・一般ウェブに対応。結果はワークスペースのファイルに保存される |
| `read` | ワークスペース内のファイルを読み込む |
| `write` | ワークスペース内にファイルを書き込む |
| `edit` | ワークスペース内のファイルを文字列置換で編集する |
| `list` | ワークスペース内のディレクトリ一覧を取得する |
| `glob` | glob パターンでファイルを検索する |
| `grep` | 正規表現でファイル内を検索する |
| `browserless_search` | ウェブ検索を実行して結果（JSON）を返す |
| `browserless_function` | Puppeteer コードをブラウザで実行する |
| `tavily_search` | Tavily Search API でウェブ検索を実行。最新情報の取得やファクトチェックに使う |

**注意:** `webfetch` は削除済み。ウェブアクセスはすべて `agent-reach` または `bash` 経由で行う。

### Browserless ツールの使用制限

`src/tools/browserless.ts` が提供するツールのうち、**以下の2つはローカル LLM では使用禁止**とする。

| ツール | 理由 |
|--------|------|
| `browserless_content` | JavaScript 描画後の HTML 全文をそのままコンテキストに流し込む。重いサイトでは数十万トークン規模になりコンテキスト爆発する |
| `browserless_smart_scrape` | JS ブロック回避の自動フォールバックが働くと内部的に `content` 相当の処理に落ちる。同様にコンテキストオーバーが発生する |

**使って良いもの（ローカル LLM でも安全）:**

| ツール | 理由 |
|--------|------|
| `browserless_search` | 検索結果（件数・スニペット）のみ返す。出力サイズが予測可能 |
| `browserless_function` | Puppeteer コードで取得対象を自分で絞り込めるため、返却サイズをコントロールできる |

**代替手段:** 一般的なウェブコンテンツ取得は `agent-reach` スキル（`r.jina.ai` 経由）を使う。Jina Reader はマークダウン変換済みの本文のみを返すため、HTML 全文よりも大幅にトークン数が少ない。

## Discord へのツールコール通知

エージェントがツールを実行するたびに Discord チャンネルへ通知が届く（`🔧 \`toolName\``）。

### 引数の表示設定

`group.json` の `toolLogArgs` で引数を表示するかどうかをグループごとに設定できる。

| 値 | 挙動 |
|----|------|
| `false`（省略時デフォルト） | ツール名のみ表示。引数は送信しない（セキュリティ上の安全側） |
| `true` | ツール名 + 引数 JSON を表示（先頭 300 文字で切り詰め） |

```json
{
  "model": { "provider": "opencode-go", "modelId": "kimi-k2.6" },
  "tools": ["bash", "read", "write"],
  "autoReply": true,
  "toolLogArgs": true
}
```

> **注意:** `bash` ツールは `echo $OPENCODE_API_KEY` のようなコマンドを引数に含む場合がある。
> `toolLogArgs: true` にする場合は Discord チャンネルの閲覧者を考慮すること。

## スキル

`groups/{name}/SKILLS/{skill}/SKILL.md` に配置するプロンプトテンプレート。ユーザーがスキル名で呼び出すと、テンプレートがシステムプロンプトに注入される。

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

### explain

**場所:** `templates/SKILLS/explain/SKILL.md`

技術用語を使わず、実際の挙動に焦点を当てた説明を生成するスキル。

### session-logs

**場所:** `templates/SKILLS/session-logs/SKILL.md`

自分自身の過去のセッションログ(`/sessions/*/*.jsonl`)を jq/grep で検索・集計するスキル。`MEMORY.md` に無い過去の会話について聞かれたときに使う。PR #87 のセッションマウント絞り込みにより、自グループのログのみが見える。

### 日次記録・週次MEMORY.md更新(memory-daily / memory-weekly cron)

専用スキルは設けず、`config/config.json` の `cron` 配列に prompt-only ジョブを登録し、`session-logs` スキルの使い方と出力フォーマットをそのまま `prompt` に書く(`config.example.json` 参照)。出力フォーマットは個人の好みに依存するため、共有テンプレートにはしない。

導入するグループには `session-logs` を `skills` に追加し、`bash` / `write` / `edit` ツールを有効にする。
