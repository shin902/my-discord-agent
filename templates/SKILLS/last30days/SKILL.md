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
bash /workspace/SKILLS/last30days/scripts/hn-search.sh "TOPIC"
```

### 2. Reddit (via the agent-reach Tool Proxy capability)

```bash
bash /workspace/SKILLS/last30days/scripts/reddit-search.sh "TOPIC"
```

### 3. GitHub (no API key required)

```bash
# Public GitHub Issues/PRs, sorted by reactions
bash /workspace/SKILLS/last30days/scripts/github-search.sh "TOPIC"
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

- Each source is fetched independently through Tool Proxy and a disposable Tool Runtime. Retry individual commands when necessary; do not fall back to direct Internet access. Reddit retrieval uses the `agent-reach` capability. Do not read `CREDENTIAL_PROXY_JSON` or Reddit cookie files from the sandbox; if the Tool Proxy or Runtime is unavailable, report the retrieval error.
- If there are too few results, also use an English query.
