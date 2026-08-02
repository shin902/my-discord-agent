---
name: last30days
description: "Research and aggregate what people have actually said about a topic during the last 30 days across multiple sources such as Reddit, HackerNews, GitHub, and YouTube."
---

# last30days skill

Collect and summarize real discussions, reactions, and trends about any topic from multiple platforms over the past 30 days.

## Usage

Trigger this skill when the user says 「`/last30days <トピック>`」 or 「過去30日の〜を調べて」.

## Research procedure

### 1. HackerNews (no API key required)

```bash
# Search the past 30 days with the Algolia API
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

### 2. Reddit (via the credential proxy)

```bash
bash /workspace/SKILLS/last30days/scripts/reddit-search.sh "TOPIC"
```

### 3. GitHub (no API key required)

```bash
# Search GitHub Issues/Discussions
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


## Aggregation and output

Summarize the data collected from each source in the following format. The headings and labels in this template are fixed output labels and must remain unchanged:

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

## Notes

- Reddit requires the `reddit` provider configuration in `credentials.json`; skip it when the configuration is missing.
- If there are too few results, also use an English query.
