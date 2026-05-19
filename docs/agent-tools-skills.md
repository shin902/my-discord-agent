# エージェントのツールとスキル

エージェントが使えるツールとスキルの概要。グループ設定（`groups/{name}/group.json`）と `AGENTS.md` でどれを有効にするかを制御する。

## ツール

エージェントに渡す MCP ツール群。`group.json` の `tools` フィールドで指定する。

| ツール名 | 概要 |
|---------|------|
| `bash` | サンドボックス内でシェルコマンドを実行。`agent-reach` スキルで使う CLI ツール群はここ経由で動く |
| `url-fetch` | URLを自動判定してコンテンツを取得。YouTube・Reddit・GitHub・RSS・一般ウェブに対応。結果はワークスペースのファイルに保存される |
| `read` | ワークスペース内のファイルを読み込む |
| `write` | ワークスペース内にファイルを書き込む |
| `edit` | ワークスペース内のファイルを文字列置換で編集する |
| `list` | ワークスペース内のディレクトリ一覧を取得する |
| `glob` | glob パターンでファイルを検索する |
| `grep` | 正規表現でファイル内を検索する |

**注意:** `webfetch` は削除済み。ウェブアクセスはすべて `url-fetch` または `bash` 経由で行う。

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
