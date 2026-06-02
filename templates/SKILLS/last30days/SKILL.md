---
name: last30days
description: "トピックについて過去30日間に人々が実際に語ったことを、Reddit・HackerNews・GitHub・YouTube など複数ソースから横断的に調査・集約するスキル。"
---

# last30days スキル

任意のトピックについて、過去30日間のリアルな議論・反応・動向を複数プラットフォームから収集してまとめる。

## 使い方

ユーザーが「`/last30days <トピック>`」または「過去30日の〜を調べて」と言ったらこのスキルを起動する。

## 調査手順

### 1. HackerNews（APIキー不要）

```bash
# Algolia API で過去30日分を検索
curl -sG "https://hn.algolia.com/api/v1/search" \
  --data-urlencode "query=TOPIC" \
  --data-urlencode "tags=story" \
  --data-urlencode "numericFilters=created_at_i>$(date -d '30 days ago' +%s)" \
  --data-urlencode "hitsPerPage=10" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for h in data.get('hits', []):
    print(f\"[{h.get('points',0)}pt] {h['title']}\")
    print(f\"  {h.get('url','')}\")
    print(f\"  comments: {h.get('num_comments',0)}\")
"
```

### 2. Reddit（APIキー不要）

```bash
# Reddit 検索（JSON API）
curl -sG "https://www.reddit.com/search.json" \
  -H "User-Agent: research-bot/1.0" \
  --data-urlencode "q=TOPIC" \
  --data-urlencode "sort=top" \
  --data-urlencode "t=month" \
  --data-urlencode "limit=10" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data.get('data', {}).get('children', []):
    d = p['data']
    print(f\"[{d.get('score',0)}] r/{d['subreddit']}: {d['title']}\")
    print(f\"  https://reddit.com{d.get('permalink','')}\")
"
```

### 3. GitHub（APIキー不要）

```bash
# GitHub Issues/Discussions 検索
SINCE=$(date -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)
curl -s "https://api.github.com/search/issues?q=TOPIC+updated:>$SINCE&sort=reactions&per_page=5" \
  -H "Accept: application/vnd.github.v3+json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for i in data.get('items', []):
    print(f\"[{i.get('reactions',{}).get('total_count',0)}👍] {i['title']}\")
    print(f\"  {i['html_url']}\")
"
```


## 集約と出力

各ソースから収集したデータを以下の形式でまとめる：

```
## 「TOPIC」過去30日の動向

### 注目トピック
- 最も反応が多かった投稿・議論を3〜5件

### プラットフォーム別サマリー
- **HackerNews**: 主な議論の論点
- **Reddit**: 代表的なスレッドと感情傾向
- **GitHub**: 関連イシュー・PR の動き

### 全体的なセンチメント
肯定的 / 否定的 / 中立 のバランスと主な理由

### 注目リンク
実際に役立つURLを3〜5件
```

## 注意事項

- Reddit API は未認証では rate limit が厳しい。失敗したら間隔を置いて再試行
- 結果が少ない場合は英語クエリも併用する
