---
name: "finance-setup"
description: "収支・サブスク管理用のSQLiteデータベースを初期構築する。「家計管理を始めたい」「収支を記録したい」「finance をセットアップして」と言われたとき、または finance スキルを使う前に一度だけ実行する。"
---

# finance-setup

`/workspace/finance.db` に収支管理用のSQLiteデータベースを作成する。一回限りの初期化処理。日常の記録・照会は `finance` スキルを使う。

## 手順

### 1. 既存DBを確認する

```bash
ls /workspace/finance.db 2>/dev/null && echo "exists" || echo "not found"
```

既に存在する場合はセットアップ済みとしてユーザーに伝え、上書きしない。
テーブル構造を確認したい場合は `.schema` で確認する。

```bash
sqlite3 /workspace/finance.db ".schema"
```

### 2. DBとテーブルを作成する

```bash
sqlite3 /workspace/finance.db "
CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT    NOT NULL,  -- YYYY-MM-DD
  amount      INTEGER NOT NULL,  -- 収入: 正、支出: 負（円）
  category    TEXT,
  description TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  amount      INTEGER NOT NULL,  -- 収入: 正、支出: 負（円）
  cycle       TEXT    NOT NULL,  -- 'monthly' | 'yearly' | 'weekly'
  next_date   TEXT    NOT NULL,  -- YYYY-MM-DD
  category    TEXT,
  active      INTEGER NOT NULL DEFAULT 1
);
"
```

### 3. 確認して報告する

```bash
sqlite3 /workspace/finance.db ".tables"
```

作成したテーブルの一覧をユーザーに伝える。次のステップとして `finance` スキルの使い方を簡単に案内する。
