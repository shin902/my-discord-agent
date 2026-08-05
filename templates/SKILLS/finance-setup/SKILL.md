---
name: "finance-setup"
description: "Initialize the SQLite database for expense and subscription management. Use this when the user says 「家計管理を始めたい」, 「収支を記録したい」, or 「finance をセットアップして」, or once before using the finance skill. Run only once."
---

# finance-setup

Create the SQLite database for income and expense management at `/workspace/finance.db`. This is a one-time initialization. Use the `finance` skill for routine recording and queries.

## Procedure

### 1. Check for an existing database

```bash
ls /workspace/finance.db 2>/dev/null && echo "exists" || echo "not found"
```

If it already exists, tell the user that setup is complete and do not overwrite it.
To inspect the table structure, use `.schema`.

```bash
sqlite3 /workspace/finance.db ".schema"
```

### 2. Create the database and tables

```bash
sqlite3 /workspace/finance.db "
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT    NOT NULL,  -- YYYY-MM-DD
  amount      INTEGER NOT NULL,  -- Income: positive; expense: negative (yen)
  category    TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  amount      INTEGER NOT NULL,  -- Income: positive; expense: negative (yen)
  cycle       TEXT    NOT NULL,  -- 'monthly' | 'yearly' | 'weekly'
  next_date   TEXT    NOT NULL,  -- YYYY-MM-DD
  category    TEXT,
  active      INTEGER NOT NULL DEFAULT 1
);
"
```

### 3. Verify and report

```bash
sqlite3 /workspace/finance.db ".tables"
```

Tell the user which tables were created. As the next step, briefly explain how to use the `finance` skill.
