---
name: "finance"
description: "Record, query, and manage expenses, income, and subscriptions. Use this when the user says 「〇〇円使った」, 「収入があった」, 「今月いくら使った？」, 「サブスクを登録して」, 「サブスク一覧」, or 「来週更新があるサブスクは？」. The database is /workspace/finance.db; if it does not exist, run finance-setup first."
---

# finance

Manage income, expenses, and subscriptions by operating the SQLite database at `/workspace/finance.db` directly.

Database path: `/workspace/finance.db`

## Subscription history model

Treat `subscriptions` as an append-only state history.

- Never `UPDATE` or delete an existing subscription state row during normal operation.
- Registration, renewal, price changes, cycle changes, category changes, cancellation, and reactivation all create a new row with `INSERT`.
- Rows with the same `name` are successive snapshots of the same logical subscription.
- The row with the largest `id` for each `name` is its current state.
- Older rows are history and must remain queryable.
- `recorded_at` records when the snapshot was written. Existing databases may have legacy rows where it is `NULL`.

For an existing database created before `recorded_at` was introduced, check the schema once and add the column if it is missing:

```bash
if ! sqlite3 /workspace/finance.db "SELECT name FROM pragma_table_info('subscriptions') WHERE name = 'recorded_at';" | grep -q '^recorded_at$'; then
  sqlite3 /workspace/finance.db "ALTER TABLE subscriptions ADD COLUMN recorded_at TEXT;"
fi
```

Do not backfill legacy rows with guessed timestamps.

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
INSERT INTO subscriptions (name, amount, cycle, next_date, category, active, recorded_at)
VALUES ('Netflix', -1490, 'monthly', '2026-07-15', 'エンタメ', 1, CURRENT_TIMESTAMP);
"
```

### Query current subscriptions

Always reduce subscription history to the latest row per `name` before answering current-state questions.

```bash
# List active subscriptions
sqlite3 /workspace/finance.db "
WITH current_subscriptions AS (
  SELECT s.*
  FROM subscriptions AS s
  JOIN (
    SELECT name, MAX(id) AS id
    FROM subscriptions
    GROUP BY name
  ) AS latest
    ON latest.id = s.id
)
SELECT name, amount, cycle, next_date, category
FROM current_subscriptions
WHERE active = 1
ORDER BY next_date;
"

# Subscriptions renewing within the next 7 days
sqlite3 /workspace/finance.db "
WITH current_subscriptions AS (
  SELECT s.*
  FROM subscriptions AS s
  JOIN (
    SELECT name, MAX(id) AS id
    FROM subscriptions
    GROUP BY name
  ) AS latest
    ON latest.id = s.id
)
SELECT name, amount, next_date
FROM current_subscriptions
WHERE active = 1
  AND next_date BETWEEN date('now') AND date('now', '+7 days')
ORDER BY next_date;
"

# Total monthly-equivalent cost
sqlite3 /workspace/finance.db "
WITH current_subscriptions AS (
  SELECT s.*
  FROM subscriptions AS s
  JOIN (
    SELECT name, MAX(id) AS id
    FROM subscriptions
    GROUP BY name
  ) AS latest
    ON latest.id = s.id
)
SELECT
  SUM(CASE WHEN cycle = 'monthly' THEN amount
           WHEN cycle = 'yearly'  THEN CAST(amount * 1.0 / 12 AS INTEGER)
           WHEN cycle = 'weekly'  THEN CAST(amount * 52.0 / 12 AS INTEGER)
           ELSE amount END) AS monthly_cost
FROM current_subscriptions
WHERE active = 1;
"
```

### Query subscription history

```bash
sqlite3 /workspace/finance.db "
SELECT id, recorded_at, name, amount, cycle, next_date, category, active
FROM subscriptions
WHERE name = 'Netflix'
ORDER BY id;
"
```

### Record a renewal

Copy the latest state into a new row and advance only `next_date`.

```bash
sqlite3 /workspace/finance.db "
INSERT INTO subscriptions (name, amount, cycle, next_date, category, active, recorded_at)
SELECT
  name,
  amount,
  cycle,
  CASE cycle
    WHEN 'monthly' THEN date(next_date, '+1 month')
    WHEN 'yearly'  THEN date(next_date, '+1 year')
    WHEN 'weekly'  THEN date(next_date, '+7 days')
    ELSE next_date
  END,
  category,
  active,
  CURRENT_TIMESTAMP
FROM subscriptions
WHERE id = (
  SELECT MAX(id)
  FROM subscriptions
  WHERE name = 'Netflix'
);
"
```

### Cancel a subscription

Copy the latest state into a new row with `active = 0` instead of overwriting the old row.

```bash
sqlite3 /workspace/finance.db "
INSERT INTO subscriptions (name, amount, cycle, next_date, category, active, recorded_at)
SELECT name, amount, cycle, next_date, category, 0, CURRENT_TIMESTAMP
FROM subscriptions
WHERE id = (
  SELECT MAX(id)
  FROM subscriptions
  WHERE name = 'Netflix'
);
"
```

Use the same append-only copy-and-change pattern for price, cycle, category, and reactivation changes.

## Notes

- Use the category string exactly as specified by the user; do not normalize it.
- Monetary amounts are always integers in yen.
- Use `name` as the logical subscription identity, matching the existing finance skill behavior. If duplicate subscriptions with the same name need to be tracked independently in the future, introduce a stable subscription key then rather than complicating the current schema preemptively.
- If the schema is missing columns, you may add them with `ALTER TABLE`, but do not mutate historical subscription rows during normal operation.
