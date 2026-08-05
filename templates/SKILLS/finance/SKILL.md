---
name: "finance"
description: "Record, query, and manage expenses, income, and subscriptions. Use this when the user says 「〇〇円使った」, 「収入があった」, 「今月いくら使った？」, 「サブスクを登録して」, 「サブスク一覧」, or 「来週更新があるサブスクは？」. The database is /workspace/finance.db; if it does not exist, run finance-setup first."
---

# finance

Manage income, expenses, and subscriptions by operating the SQLite database at `/workspace/finance.db` directly.

Database path: `/workspace/finance.db`

## Operation reference

### Record income and expenses

```bash
# Expense (negative value)
sqlite3 /workspace/finance.db "
INSERT INTO transactions (date, amount, category, description)
VALUES ('2026-06-27', -800, '食費', 'コンビニ');
"

# Income (positive value)
sqlite3 /workspace/finance.db "
INSERT INTO transactions (date, amount, category, description)
VALUES ('2026-06-27', 250000, '給与', '6月分');
"
```

When the user says 「今日」, 「昨日」, or similar, obtain the date with `date +%Y-%m-%d`.

```bash
date +%Y-%m-%d
```

### Query income and expenses

```bash
# This month's total (income and expenses)
sqlite3 /workspace/finance.db "
SELECT
  SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
  SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expense,
  SUM(amount) AS net
FROM transactions
WHERE date LIKE '$(date +%Y-%m)%';
"

# Totals by category
sqlite3 /workspace/finance.db "
SELECT category, SUM(amount) AS total
FROM transactions
WHERE date LIKE '$(date +%Y-%m)%'
GROUP BY category
ORDER BY total;
"

# Most recent N entries
sqlite3 /workspace/finance.db "
SELECT date, amount, category, description
FROM transactions
ORDER BY date DESC, id DESC
LIMIT 10;
"
```

### Register a subscription

```bash
sqlite3 /workspace/finance.db "
INSERT INTO subscriptions (name, amount, cycle, next_date, category)
VALUES ('Netflix', -1490, 'monthly', '2026-07-15', 'エンタメ');
"
```

### Query subscriptions

```bash
# List active subscriptions
sqlite3 /workspace/finance.db "
SELECT name, amount, cycle, next_date, category
FROM subscriptions
WHERE active = 1
ORDER BY next_date;
"

# Subscriptions renewing within the next 7 days
sqlite3 /workspace/finance.db "
SELECT name, amount, next_date
FROM subscriptions
WHERE active = 1
  AND next_date BETWEEN date('now') AND date('now', '+7 days')
ORDER BY next_date;
"

# Total monthly-equivalent cost
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

### Update a subscription's next_date (after renewal)

```bash
sqlite3 /workspace/finance.db "
UPDATE subscriptions
SET next_date = date(next_date, '+1 month')
WHERE name = 'Netflix';
"
```

Choose `'+1 month'`, `'+1 year'`, or `'+7 days'` according to `cycle`.

### Cancel a subscription

```bash
sqlite3 /workspace/finance.db "
UPDATE subscriptions SET active = 0 WHERE name = 'Netflix';
"
```

## Notes

- Use the category string exactly as specified by the user; do not normalize it.
- Monetary amounts are always integers in yen.
- If the schema is missing columns, you may add them with `ALTER TABLE`.
