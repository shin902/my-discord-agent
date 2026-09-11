#!/usr/bin/env python3
"""Self-contained sandbox-local Finance CLI backed by /workspace/finance.db."""
import argparse
import datetime
from contextlib import contextmanager
import json
import re
import sqlite3
import sys
from pathlib import Path
from zoneinfo import ZoneInfo


DATABASE_PATH = "/workspace/finance.db"
MAX_SAFE_INTEGER = 9007199254740991
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CYCLES = ("monthly", "yearly", "weekly")
TRANSACTION_TYPES = ("income", "expense")


def current_date():
    return datetime.datetime.now(ZoneInfo("Asia/Tokyo")).date().isoformat()


def assert_date(value, label):
    if not isinstance(value, str) or DATE_PATTERN.fullmatch(value) is None:
        raise ValueError(f"{label} が不正な日付です: {value}")
    try:
        parsed = datetime.date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"{label} が不正な日付です: {value}") from None
    if parsed.isoformat() != value:
        raise ValueError(f"{label} が不正な日付です: {value}")


def assert_date_range(from_date=None, to_date=None):
    if from_date:
        assert_date(from_date, "from")
    if to_date:
        assert_date(to_date, "to")
    if from_date and to_date and from_date > to_date:
        raise ValueError("from は to 以前の日付にしてください")


def assert_amount(value):
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > MAX_SAFE_INTEGER:
        raise ValueError("amount は正の整数で指定してください")


def assert_max_length(value, maximum, label):
    if value is not None and len(value) > maximum:
        raise ValueError(f"{label} は{maximum}文字以内で指定してください")


def assert_name(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 200:
        raise ValueError("name は1〜200文字で指定してください")


def assert_category(value):
    if value is not None:
        assert_max_length(value, 200, "category")


def connect_database(db_path):
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          amount INTEGER NOT NULL,
          category TEXT,
          description TEXT
        );

        CREATE TABLE IF NOT EXISTS subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          amount INTEGER NOT NULL,
          cycle TEXT NOT NULL,
          next_date TEXT NOT NULL,
          category TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    columns = {row[1] for row in db.execute("PRAGMA table_info(subscriptions)")}
    if "recorded_at" not in columns:
        db.execute("ALTER TABLE subscriptions ADD COLUMN recorded_at TEXT")
        db.commit()
    return db


@contextmanager
def with_database(db_path):
    db = connect_database(db_path)
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    else:
        db.commit()
    finally:
        db.close()


def public_transaction(row):
    amount = row["amount"]
    return {
        "id": row["id"],
        "date": row["date"],
        "type": "expense" if amount < 0 else "income",
        "amount": amount,
        "category": row["category"],
        "description": row["description"],
    }


def public_subscription(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "amount": abs(row["amount"]),
        "cycle": row["cycle"],
        "nextDate": row["next_date"],
        "category": row["category"],
        "active": row["active"] == 1,
        "recordedAt": row["recorded_at"],
    }


def insert_subscription(db, state):
    cursor = db.execute(
        """
        INSERT INTO subscriptions
          (name, amount, cycle, next_date, category, active)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            state["name"],
            state["amount"],
            state["cycle"],
            state["next_date"],
            state["category"],
            state["active"],
        ),
    )
    return db.execute(
        """
        SELECT id, name, amount, cycle, next_date, category, active, recorded_at
        FROM subscriptions WHERE id = ?
        """,
        (cursor.lastrowid,),
    ).fetchone()


def latest_subscription(db, name):
    return db.execute(
        """
        SELECT id, name, amount, cycle, next_date, category, active, recorded_at
        FROM subscriptions WHERE name = ? ORDER BY id DESC LIMIT 1
        """,
        (name,),
    ).fetchone()


def current_month_range():
    today = current_date()
    year, month, _ = today.split("-")
    first = f"{year}-{month}-01"
    next_month = datetime.date(int(year), int(month), 1) + datetime.timedelta(days=32)
    last = datetime.date(next_month.year, next_month.month, 1) - datetime.timedelta(days=1)
    return first, last.isoformat()


def record_transaction(input_data, db_path):
    transaction_type = input_data["type"]
    if transaction_type not in TRANSACTION_TYPES:
        raise ValueError("type は income または expense で指定してください")
    amount = input_data["amount"]
    assert_amount(amount)
    date = input_data.get("date") or current_date()
    assert_date(date, "date")
    category = input_data.get("category")
    description = input_data.get("description")
    assert_category(category)
    assert_max_length(description, 2000, "description")
    signed = -amount if transaction_type == "expense" else amount
    with with_database(db_path) as db:
        cursor = db.execute(
            """
            INSERT INTO transactions (date, amount, category, description)
            VALUES (?, ?, ?, ?)
            """,
            (date, signed, category, description),
        )
        row = db.execute(
            """
            SELECT id, date, amount, category, description
            FROM transactions WHERE id = ?
            """,
            (cursor.lastrowid,),
        ).fetchone()
        return public_transaction(row)


def list_transactions(input_data, db_path):
    from_date = input_data.get("from")
    to_date = input_data.get("to")
    assert_date_range(from_date, to_date)
    category = input_data.get("category")
    assert_category(category)
    transaction_type = input_data.get("type")
    if transaction_type is not None and transaction_type not in TRANSACTION_TYPES:
        raise ValueError("type は income または expense で指定してください")
    limit = input_data.get("limit", 50)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise ValueError("limit は1〜100の整数で指定してください")

    where = []
    values = []
    if from_date:
        where.append("date >= ?")
        values.append(from_date)
    if to_date:
        where.append("date <= ?")
        values.append(to_date)
    if category is not None:
        where.append("category = ?")
        values.append(category)
    if transaction_type == "income":
        where.append("amount > 0")
    if transaction_type == "expense":
        where.append("amount < 0")
    values.append(limit)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    with with_database(db_path) as db:
        rows = db.execute(
            f"""
            SELECT id, date, amount, category, description
            FROM transactions {clause}
            ORDER BY date DESC, id DESC LIMIT ?
            """,
            values,
        ).fetchall()
        return [public_transaction(row) for row in rows]


def summary(input_data, db_path):
    from_date = input_data.get("from")
    to_date = input_data.get("to")
    if not from_date and not to_date:
        from_date, to_date = current_month_range()
    assert_date_range(from_date, to_date)
    where = []
    values = []
    if from_date:
        where.append("date >= ?")
        values.append(from_date)
    if to_date:
        where.append("date <= ?")
        values.append(to_date)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    with with_database(db_path) as db:
        totals = db.execute(
            f"""
            SELECT
              SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
              SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expense,
              SUM(amount) AS net
            FROM transactions {clause}
            """,
            values,
        ).fetchone()
        categories = db.execute(
            f"""
            SELECT category, SUM(amount) AS total
            FROM transactions {clause}{' AND' if clause else 'WHERE'} amount < 0
            GROUP BY category ORDER BY total ASC
            """,
            values,
        ).fetchall()
        return {
            "from": from_date,
            "to": to_date,
            "income": totals["income"] or 0,
            "expense": totals["expense"] or 0,
            "net": totals["net"] or 0,
            "categories": [
                {"category": row["category"], "total": row["total"]}
                for row in categories
            ],
        }


def add_subscription(input_data, db_path):
    name = input_data["name"]
    assert_name(name)
    amount = input_data["amount"]
    assert_amount(amount)
    cycle = input_data["cycle"]
    if cycle not in CYCLES:
        raise ValueError("cycle は monthly、yearly、weekly のいずれかで指定してください")
    next_date = input_data["nextDate"]
    assert_date(next_date, "nextDate")
    category = input_data.get("category")
    assert_category(category)
    with with_database(db_path) as db:
        row = insert_subscription(
            db,
            {
                "name": name,
                "amount": -amount,
                "cycle": cycle,
                "next_date": next_date,
                "category": category,
                "active": 1,
            },
        )
        return public_subscription(row)


def update_subscription(input_data, db_path):
    name = input_data["name"]
    assert_name(name)
    if "amount" in input_data:
        assert_amount(input_data["amount"])
    if "cycle" in input_data and input_data["cycle"] not in CYCLES:
        raise ValueError("cycle は monthly、yearly、weekly のいずれかで指定してください")
    if "nextDate" in input_data:
        assert_date(input_data["nextDate"], "nextDate")
    if "category" in input_data:
        assert_category(input_data["category"])
    if "active" in input_data and not isinstance(input_data["active"], bool):
        raise ValueError("active は真偽値で指定してください")
    if not any(
        key in input_data for key in ("amount", "cycle", "nextDate", "category", "active")
    ):
        raise ValueError("変更する項目を1つ以上指定してください")

    with with_database(db_path) as db:
        previous = latest_subscription(db, name)
        if previous is None:
            raise ValueError(f"サブスクが見つかりません: {name}")
        row = insert_subscription(
            db,
            {
                "name": previous["name"],
                "amount": -input_data["amount"] if "amount" in input_data else previous["amount"],
                "cycle": input_data.get("cycle", previous["cycle"]),
                "next_date": input_data.get("nextDate", previous["next_date"]),
                "category": input_data["category"] if "category" in input_data else previous["category"],
                "active": (
                    1 if input_data["active"] else 0
                ) if "active" in input_data else previous["active"],
            },
        )
        return public_subscription(row)


def cancel_subscription(input_data, db_path):
    name = input_data["name"]
    assert_name(name)
    with with_database(db_path) as db:
        previous = latest_subscription(db, name)
        if previous is None:
            raise ValueError(f"サブスクが見つかりません: {name}")
        row = insert_subscription(
            db,
            {
                "name": previous["name"],
                "amount": previous["amount"],
                "cycle": previous["cycle"],
                "next_date": previous["next_date"],
                "category": previous["category"],
                "active": 0,
            },
        )
        return public_subscription(row)


def list_subscriptions(input_data, db_path):
    with with_database(db_path) as db:
        rows = db.execute(
            f"""
            WITH latest AS (
              SELECT name, MAX(id) AS id FROM subscriptions GROUP BY name
            )
            SELECT s.id, s.name, s.amount, s.cycle, s.next_date,
                   s.category, s.active, s.recorded_at
            FROM subscriptions s JOIN latest ON latest.id = s.id
            {'' if input_data.get('includeInactive') else 'WHERE s.active = 1'}
            ORDER BY s.next_date ASC, s.name ASC
            """
        ).fetchall()
        return [public_subscription(row) for row in rows]


def subscription_history(input_data, db_path):
    name = input_data["name"]
    assert_name(name)
    with with_database(db_path) as db:
        rows = db.execute(
            """
            SELECT id, name, amount, cycle, next_date, category, active, recorded_at
            FROM subscriptions WHERE name = ? ORDER BY id ASC
            """,
            (name,),
        ).fetchall()
        return [public_subscription(row) for row in rows]


def execute_operation(operation, input_data, db_path=DATABASE_PATH):
    operations = {
        "record-transaction": record_transaction,
        "list-transactions": list_transactions,
        "summary": summary,
        "add-subscription": add_subscription,
        "update-subscription": update_subscription,
        "cancel-subscription": cancel_subscription,
        "list-subscriptions": list_subscriptions,
        "subscription-history": subscription_history,
    }
    try:
        handler = operations[operation]
    except KeyError:
        raise ValueError(f"unknown finance operation: {operation}") from None
    return handler(input_data, db_path)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="finance.py",
        description="Record and review finances in the sandbox-local /workspace/finance.db",
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    record = commands.add_parser("record-transaction", help="record income or expense")
    record.add_argument("type", choices=TRANSACTION_TYPES)
    record.add_argument("amount", type=int)
    record.add_argument("--date")
    record.add_argument("--category")
    record.add_argument("--description")

    transactions = commands.add_parser("list-transactions", help="list transactions")
    transactions.add_argument("--from", dest="from_date")
    transactions.add_argument("--to", dest="to_date")
    transactions.add_argument("--category")
    transactions.add_argument("--type", choices=TRANSACTION_TYPES)
    transactions.add_argument("--limit", type=int)

    summary_parser = commands.add_parser("summary", help="summarize transactions")
    summary_parser.add_argument("--from", dest="from_date")
    summary_parser.add_argument("--to", dest="to_date")

    add = commands.add_parser("add-subscription", help="add a subscription")
    add.add_argument("name")
    add.add_argument("amount", type=int)
    add.add_argument("cycle", choices=CYCLES)
    add.add_argument("next_date")
    add.add_argument("--category")

    update = commands.add_parser("update-subscription", help="append a subscription update")
    update.add_argument("name")
    update.add_argument("--amount", type=int)
    update.add_argument("--cycle", choices=CYCLES)
    update.add_argument("--next-date", dest="next_date")
    category = update.add_mutually_exclusive_group()
    category.add_argument("--category")
    category.add_argument("--clear-category", action="store_true")
    active = update.add_mutually_exclusive_group()
    active.add_argument("--active", dest="active", action="store_true")
    active.add_argument("--inactive", dest="active", action="store_false")
    update.set_defaults(active=None, clear_category=False)

    cancel = commands.add_parser("cancel-subscription", help="append an inactive snapshot")
    cancel.add_argument("name")

    list_subs = commands.add_parser("list-subscriptions", help="list current subscriptions")
    list_subs.add_argument("--include-inactive", action="store_true")

    history = commands.add_parser("subscription-history", help="list subscription snapshots")
    history.add_argument("name")

    return parser


def input_from_args(args):
    operation = args.operation
    if operation == "record-transaction":
        data = {"type": args.type, "amount": args.amount}
        if args.date is not None:
            data["date"] = args.date
        if args.category is not None:
            data["category"] = args.category
        if args.description is not None:
            data["description"] = args.description
        return data
    if operation == "list-transactions":
        data = {}
        for source, target in (
            ("from_date", "from"),
            ("to_date", "to"),
            ("category", "category"),
            ("type", "type"),
            ("limit", "limit"),
        ):
            value = getattr(args, source)
            if value is not None:
                data[target] = value
        return data
    if operation == "summary":
        data = {}
        if args.from_date is not None:
            data["from"] = args.from_date
        if args.to_date is not None:
            data["to"] = args.to_date
        return data
    if operation == "add-subscription":
        data = {
            "name": args.name,
            "amount": args.amount,
            "cycle": args.cycle,
            "nextDate": args.next_date,
        }
        if args.category is not None:
            data["category"] = args.category
        return data
    if operation == "update-subscription":
        data = {"name": args.name}
        for source, target in (
            ("amount", "amount"),
            ("cycle", "cycle"),
            ("next_date", "nextDate"),
        ):
            value = getattr(args, source)
            if value is not None:
                data[target] = value
        if args.clear_category:
            data["category"] = None
        elif args.category is not None:
            data["category"] = args.category
        if args.active is not None:
            data["active"] = args.active
        return data
    if operation == "list-subscriptions":
        return {"includeInactive": args.include_inactive} if args.include_inactive else {}
    return {"name": args.name}


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    try:
        result = execute_operation(args.operation, input_from_args(args), DATABASE_PATH)
    except (OSError, sqlite3.Error, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
