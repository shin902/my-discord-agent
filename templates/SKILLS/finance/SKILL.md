---
name: "finance"
description: "収支・サブスクリプションの記録・照会・管理を行う。「〇〇円使った」「収入があった」「今月いくら使った？」「サブスクを登録して」「サブスク一覧」「来週更新があるサブスクは？」のように言われたとき使う。DBは /workspace/finance.db（未作成なら finance-setup を先に実行）。"
---

# finance

`/workspace/finance.db` のSQLiteを直接操作して収支・サブスクを管理する。

DBパス: `/workspace/finance.db`

## 操作リファレンス

### 収支を記録する

```bash
# 支出（負の値）
sqlite3 /workspace/finance.db "
INSERT INTO transactions (date, amount, category, description)
VALUES ('2026-06-27', -800, '食費', 'コンビニ');
"

# 収入（正の値）
sqlite3 /workspace/finance.db "
INSERT INTO transactions (date, amount, category, description)
VALUES ('2026-06-27', 250000, '給与', '6月分');
"
```

日付はユーザーが「今日」「昨日」等と言った場合は `date +%Y-%m-%d` で取得する。

```bash
date +%Y-%m-%d
```

### 収支を照会する

```bash
# 今月の合計（収支）
sqlite3 /workspace/finance.db "
SELECT
  SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
  SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expense,
  SUM(amount) AS net
FROM transactions
WHERE date LIKE '$(date +%Y-%m)%';
"

# カテゴリ別集計
sqlite3 /workspace/finance.db "
SELECT category, SUM(amount) AS total
FROM transactions
WHERE date LIKE '$(date +%Y-%m)%'
GROUP BY category
ORDER BY total;
"

# 直近N件
sqlite3 /workspace/finance.db "
SELECT date, amount, category, description
FROM transactions
ORDER BY date DESC, id DESC
LIMIT 10;
"
```

### サブスクを登録する

```bash
sqlite3 /workspace/finance.db "
INSERT INTO subscriptions (name, amount, cycle, next_date, category)
VALUES ('Netflix', -1490, 'monthly', '2026-07-15', 'エンタメ');
"
```

### サブスクを照会する

```bash
# アクティブなサブスク一覧
sqlite3 /workspace/finance.db "
SELECT name, amount, cycle, next_date, category
FROM subscriptions
WHERE active = 1
ORDER BY next_date;
"

# 今後7日以内に更新があるサブスク
sqlite3 /workspace/finance.db "
SELECT name, amount, next_date
FROM subscriptions
WHERE active = 1
  AND next_date BETWEEN date('now') AND date('now', '+7 days')
ORDER BY next_date;
"

# 月額換算の合計コスト
sqlite3 /workspace/finance.db "
SELECT
  SUM(CASE WHEN cycle = 'monthly' THEN amount
           WHEN cycle = 'yearly'  THEN CAST(amount * 1.0 / 12 AS INTEGER)
           WHEN cycle = 'weekly'  THEN CAST(amount * 52.0 / 12 AS INTEGER)
           ELSE amount END) AS monthly_cost
FROM subscriptions
WHERE active = 1;
"
```

### サブスクの next_date を更新する（更新後）

```bash
sqlite3 /workspace/finance.db "
UPDATE subscriptions
SET next_date = date(next_date, '+1 month')
WHERE name = 'Netflix';
"
```

`cycle` に応じて `'+1 month'` / `'+1 year'` / `'+7 days'` を使い分ける。

### サブスクを解約する

```bash
sqlite3 /workspace/finance.db "
UPDATE subscriptions SET active = 0 WHERE name = 'Netflix';
"
```

## 注意

- カテゴリはユーザーが指定した文字列をそのまま使う。正規化しない。
- 金額の単位は常に円（整数）。
- スキーマが足りない場合は `ALTER TABLE` で列を追加してよい。
