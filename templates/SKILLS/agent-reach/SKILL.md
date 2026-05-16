---
name: agent-reach
description: ウェブ・YouTube・GitHub・Reddit・RSS のインターネット情報収集。サンドボックス内の CLI ツールを直接実行して情報取得する
---

以下のコマンドをサンドボックスで実行して情報を取得してください。

## ウェブページ取得
curl -s "https://r.jina.ai/https://example.com"

## YouTube（動画情報・字幕）
# タイトル・チャンネル等の基本情報:
curl -s "https://www.youtube.com/oembed?url=URL&format=json"
# 詳細なメタデータ:
yt-dlp --dump-json "URL"
# 字幕:
yt-dlp --write-auto-subs --sub-lang ja,en --skip-download "URL"

## GitHub
gh search repos "クエリ"
gh repo view owner/repo
gh issue list --repo owner/repo

## Reddit（認証不要 JSON API）
# サブレディット検索
curl -s "https://www.reddit.com/r/all/search.json?q=クエリ&sort=relevance&limit=10" -H "User-Agent: discord-agent/1.0"
# 特定スレッド取得
curl -s "https://www.reddit.com/r/subreddit/comments/POST_ID.json" -H "User-Agent: discord-agent/1.0"

## RSS
python3 -c "import feedparser; f=feedparser.parse('URL'); [print(e.title, e.link) for e in f.entries[:10]]"

$ARGUMENTS$
