import { createRequire as createFinanceRequire } from "node:module";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type Database from "better-sqlite3";
import { Type } from "typebox";
import { ensureFinanceDatabase } from "./finance-db.js";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
const DEFAULT_TRANSACTION_LIMIT = 50;
const MAX_TRANSACTION_LIMIT = 100;
const TOKYO_TIME_ZONE = "Asia/Tokyo";
/** The group workspace is mounted at /workspace in the Agent Runner. */
export const FINANCE_DATABASE_PATH = "/workspace/finance.db";
const require = createFinanceRequire(import.meta.url);

type TransactionType = "income" | "expense";
type SubscriptionCycle = "monthly" | "yearly" | "weekly";

type TransactionRow = {
  id: number;
  date: string;
  amount: number;
  category: string | null;
  description: string | null;
};

type SubscriptionRow = {
  id: number;
  name: string;
  amount: number;
  cycle: SubscriptionCycle;
  next_date: string;
  category: string | null;
  active: number;
  recorded_at: string | null;
};

type PublicTransaction = {
  id: number;
  date: string;
  type: TransactionType;
  amount: number;
  category: string | null;
  description: string | null;
};

type PublicSubscription = {
  id: number;
  name: string;
  amount: number;
  cycle: SubscriptionCycle;
  nextDate: string;
  category: string | null;
  active: boolean;
  recordedAt: string | null;
};

const dateParameter = (description: string) =>
  Type.Optional(
    Type.String({
      description,
      pattern: DATE_PATTERN,
    }),
  );

const amountParameter = (description: string) =>
  Type.Integer({
    description,
    minimum: 1,
    maximum: MAX_AMOUNT,
  });

const categoryParameter = Type.Optional(
  Type.String({
    description: "User-provided category; it is kept exactly as written.",
    maxLength: 200,
  }),
);

const transactionTypeParameter = Type.Union([
  Type.Literal("income"),
  Type.Literal("expense"),
]);

const cycleParameter = Type.Union([
  Type.Literal("monthly"),
  Type.Literal("yearly"),
  Type.Literal("weekly"),
]);

function currentDate(): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TOKYO_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts();
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function currentMonthRange(): { from: string; to: string } {
  const today = currentDate();
  const [year, month] = today.split("-");
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0))
    .toISOString()
    .slice(0, 10);
  return { from: `${year}-${month}-01`, to: lastDay };
}

function assertDate(value: string, label: string): void {
  if (!new RegExp(DATE_PATTERN).test(value)) {
    throw new Error(`${label} は YYYY-MM-DD 形式で指定してください: ${value}`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} が不正な日付です: ${value}`);
  }
}

function assertDateRange(
  from: string | undefined,
  to: string | undefined,
): void {
  if (from) assertDate(from, "from");
  if (to) assertDate(to, "to");
  if (from && to && from > to) {
    throw new Error("from は to 以前の日付にしてください");
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} は正の整数で指定してください`);
  }
}

function databasePath(): string {
  // The test-only override keeps host-side unit tests out of /workspace. The
  // Runner itself always uses the fixed group workspace path above.
  return process.env.FINANCE_TEST_DB_PATH ?? FINANCE_DATABASE_PATH;
}

function withDatabase<T>(
  access: "read-only" | "read-write",
  operation: (db: Database.Database) => T,
): T {
  const dbPath = databasePath();
  ensureFinanceDatabase(dbPath);
  const DatabaseConstructor = require("better-sqlite3") as typeof Database;
  const db = new DatabaseConstructor(dbPath, {
    readonly: access === "read-only",
  });
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

function transactionFromRow(row: TransactionRow): PublicTransaction {
  return {
    id: row.id,
    date: row.date,
    type: row.amount >= 0 ? "income" : "expense",
    amount: row.amount,
    category: row.category,
    description: row.description,
  };
}

function subscriptionFromRow(row: SubscriptionRow): PublicSubscription {
  return {
    id: row.id,
    name: row.name,
    amount: Math.abs(row.amount),
    cycle: row.cycle,
    nextDate: row.next_date,
    category: row.category,
    active: row.active === 1,
    recordedAt: row.recorded_at,
  };
}

function result(
  value: unknown,
  details: Record<string, unknown>,
): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details,
  };
}

function latestSubscription(
  db: Database.Database,
  name: string,
): SubscriptionRow | undefined {
  return db
    .prepare<[string], SubscriptionRow>(
      `SELECT id, name, amount, cycle, next_date, category, active, recorded_at
       FROM subscriptions
       WHERE name = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(name);
}

const recordTransactionParameters = Type.Object({
  type: transactionTypeParameter,
  amount: amountParameter("Positive integer amount in yen."),
  date: dateParameter(
    "Transaction date in YYYY-MM-DD format. Defaults to today.",
  ),
  category: categoryParameter,
  description: Type.Optional(
    Type.String({
      description: "Optional description of the transaction.",
      maxLength: 2_000,
    }),
  ),
});

export const financeRecordTransactionTool: AgentTool<
  typeof recordTransactionParameters
> = {
  name: "finance-record-transaction",
  label: "Record Finance Transaction",
  description:
    "Record one income or expense. Amount must be a positive integer yen value; the stored sign follows the income/expense type.",
  parameters: recordTransactionParameters,
  execute: async (
    _toolCallId,
    { type, amount, date = currentDate(), category, description },
  ) => {
    assertPositiveSafeInteger(amount, "amount");
    assertDate(date, "date");
    const signedAmount = type === "income" ? amount : -amount;
    return withDatabase("read-write", (db) => {
      const insert = db.prepare(
        `INSERT INTO transactions (date, amount, category, description)
         VALUES (?, ?, ?, ?)`,
      );
      const inserted = insert.run(
        date,
        signedAmount,
        category ?? null,
        description ?? null,
      );
      const transaction = db
        .prepare<[number], TransactionRow>(
          `SELECT id, date, amount, category, description
           FROM transactions
           WHERE id = ?`,
        )
        .get(Number(inserted.lastInsertRowid));
      if (!transaction) throw new Error("記録した取引を読み取れませんでした");
      const publicTransaction = transactionFromRow(transaction);
      return result(publicTransaction, {
        operation: "record-transaction",
        transaction: publicTransaction,
      });
    });
  },
};

const listTransactionsParameters = Type.Object({
  from: dateParameter("Only transactions on or after this date."),
  to: dateParameter("Only transactions on or before this date."),
  category: categoryParameter,
  type: Type.Optional(transactionTypeParameter),
  limit: Type.Optional(
    Type.Integer({
      description: `Maximum number of transactions to return. Defaults to ${DEFAULT_TRANSACTION_LIMIT}; maximum ${MAX_TRANSACTION_LIMIT}.`,
      minimum: 1,
      maximum: MAX_TRANSACTION_LIMIT,
    }),
  ),
});

export const financeListTransactionsTool: AgentTool<
  typeof listTransactionsParameters
> = {
  name: "finance-list-transactions",
  label: "List Finance Transactions",
  description:
    "List recorded income and expenses with optional date, category, and type filters.",
  parameters: listTransactionsParameters,
  execute: async (
    _toolCallId,
    { from, to, category, type, limit = DEFAULT_TRANSACTION_LIMIT },
  ) => {
    assertDateRange(from, to);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("limit は正の整数で指定してください");
    }
    const predicates: string[] = [];
    const values: Array<string | number> = [];
    if (from) {
      predicates.push("date >= ?");
      values.push(from);
    }
    if (to) {
      predicates.push("date <= ?");
      values.push(to);
    }
    if (category !== undefined) {
      predicates.push("category = ?");
      values.push(category);
    }
    if (type === "income") predicates.push("amount > 0");
    if (type === "expense") predicates.push("amount < 0");

    return withDatabase("read-only", (db) => {
      const where =
        predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
      const rows = db
        .prepare<Array<string | number>, TransactionRow>(
          `SELECT id, date, amount, category, description
           FROM transactions
           ${where}
           ORDER BY date DESC, id DESC
           LIMIT ?`,
        )
        .all(...values, limit);
      const transactions = rows.map(transactionFromRow);
      return result(transactions, {
        operation: "list-transactions",
        count: transactions.length,
        from,
        to,
        category,
        type,
        limit,
      });
    });
  },
};

const summaryParameters = Type.Object({
  from: dateParameter("Start of the summary period."),
  to: dateParameter("End of the summary period."),
});

export const financeSummaryTool: AgentTool<typeof summaryParameters> = {
  name: "finance-summary",
  label: "Finance Summary",
  description:
    "Summarize income, expenses, net balance, and expense totals by category for a date range (current month by default).",
  parameters: summaryParameters,
  execute: async (_toolCallId, { from, to }) => {
    const defaultRange = from || to ? undefined : currentMonthRange();
    const effectiveFrom = from ?? defaultRange?.from;
    const effectiveTo = to ?? defaultRange?.to;
    assertDateRange(effectiveFrom, effectiveTo);

    return withDatabase("read-only", (db) => {
      const predicates: string[] = [];
      const values: string[] = [];
      if (effectiveFrom) {
        predicates.push("date >= ?");
        values.push(effectiveFrom);
      }
      if (effectiveTo) {
        predicates.push("date <= ?");
        values.push(effectiveTo);
      }
      const where =
        predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
      const totals = db
        .prepare<
          string[],
          { income: number | null; expense: number | null; net: number | null }
        >(
          `SELECT
             SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
             SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expense,
             SUM(amount) AS net
           FROM transactions
           ${where}`,
        )
        .get(...values);
      const categories = db
        .prepare<string[], { category: string | null; total: number }>(
          `SELECT category, SUM(amount) AS total
           FROM transactions
           ${where}${where ? " AND" : "WHERE"} amount < 0
           GROUP BY category
           ORDER BY total ASC`,
        )
        .all(...values)
        .map((row) => ({ category: row.category, total: row.total }));
      const summary = {
        from: effectiveFrom,
        to: effectiveTo,
        income: totals?.income ?? 0,
        expense: totals?.expense ?? 0,
        net: totals?.net ?? 0,
        categories,
      };
      return result(summary, {
        operation: "summary",
        from: effectiveFrom,
        to: effectiveTo,
      });
    });
  },
};

const addSubscriptionParameters = Type.Object({
  name: Type.String({
    description: "Subscription name, used as its logical identity.",
    minLength: 1,
    maxLength: 200,
  }),
  amount: amountParameter("Positive integer subscription cost in yen."),
  cycle: cycleParameter,
  nextDate: Type.String({
    description: "Next renewal date in YYYY-MM-DD format.",
    pattern: DATE_PATTERN,
  }),
  category: categoryParameter,
});

export const financeAddSubscriptionTool: AgentTool<
  typeof addSubscriptionParameters
> = {
  name: "finance-add-subscription",
  label: "Add Finance Subscription",
  description:
    "Add a subscription expense. Subscription state is stored as an append-only snapshot history.",
  parameters: addSubscriptionParameters,
  execute: async (_toolCallId, { name, amount, cycle, nextDate, category }) => {
    assertPositiveSafeInteger(amount, "amount");
    assertDate(nextDate, "nextDate");
    return withDatabase("read-write", (db) => {
      const inserted = db
        .prepare(
          `INSERT INTO subscriptions
             (name, amount, cycle, next_date, category, active, recorded_at)
           VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
        )
        .run(name, -amount, cycle, nextDate, category ?? null);
      const snapshot = db
        .prepare<[number], SubscriptionRow>(
          `SELECT id, name, amount, cycle, next_date, category, active, recorded_at
           FROM subscriptions
           WHERE id = ?`,
        )
        .get(Number(inserted.lastInsertRowid));
      if (!snapshot) throw new Error("追加したサブスクを読み取れませんでした");
      const subscription = subscriptionFromRow(snapshot);
      return result(subscription, {
        operation: "add-subscription",
        subscription,
      });
    });
  },
};

const updateSubscriptionParameters = Type.Object({
  name: Type.String({
    description: "Subscription logical identity to update.",
    minLength: 1,
    maxLength: 200,
  }),
  amount: Type.Optional(
    amountParameter("New positive integer subscription cost in yen."),
  ),
  cycle: Type.Optional(cycleParameter),
  nextDate: Type.Optional(
    Type.String({
      description: "New renewal date in YYYY-MM-DD format.",
      pattern: DATE_PATTERN,
    }),
  ),
  category: Type.Optional(
    Type.Union([
      Type.String({
        description: "New user-provided category.",
        maxLength: 200,
      }),
      Type.Null(),
    ]),
  ),
  active: Type.Optional(
    Type.Boolean({
      description:
        "Optional active state; set true to reactivate a subscription.",
    }),
  ),
});

export const financeUpdateSubscriptionTool: AgentTool<
  typeof updateSubscriptionParameters
> = {
  name: "finance-update-subscription",
  label: "Update Finance Subscription",
  description:
    "Append a changed subscription snapshot without updating or deleting prior history.",
  parameters: updateSubscriptionParameters,
  execute: async (
    _toolCallId,
    { name, amount, cycle, nextDate, category, active },
  ) => {
    if (amount !== undefined) assertPositiveSafeInteger(amount, "amount");
    if (nextDate !== undefined) assertDate(nextDate, "nextDate");
    if (
      amount === undefined &&
      cycle === undefined &&
      nextDate === undefined &&
      category === undefined &&
      active === undefined
    ) {
      throw new Error("変更する項目を1つ以上指定してください");
    }

    return withDatabase("read-write", (db) => {
      const append = db.transaction(() => {
        const latest = latestSubscription(db, name);
        if (!latest) throw new Error(`サブスクが見つかりません: ${name}`);
        const inserted = db
          .prepare(
            `INSERT INTO subscriptions
               (name, amount, cycle, next_date, category, active, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          )
          .run(
            latest.name,
            amount === undefined ? latest.amount : -amount,
            cycle ?? latest.cycle,
            nextDate ?? latest.next_date,
            category === undefined ? latest.category : category,
            active === undefined ? latest.active : active ? 1 : 0,
          );
        return Number(inserted.lastInsertRowid);
      });
      const id = append();
      const snapshot = db
        .prepare<[number], SubscriptionRow>(
          `SELECT id, name, amount, cycle, next_date, category, active, recorded_at
           FROM subscriptions
           WHERE id = ?`,
        )
        .get(id);
      if (!snapshot) throw new Error("更新したサブスクを読み取れませんでした");
      const subscription = subscriptionFromRow(snapshot);
      return result(subscription, {
        operation: "update-subscription",
        subscription,
      });
    });
  },
};

const cancelSubscriptionParameters = Type.Object({
  name: Type.String({
    description: "Subscription logical identity to cancel.",
    minLength: 1,
    maxLength: 200,
  }),
});

export const financeCancelSubscriptionTool: AgentTool<
  typeof cancelSubscriptionParameters
> = {
  name: "finance-cancel-subscription",
  label: "Cancel Finance Subscription",
  description:
    "Append an inactive subscription snapshot instead of deleting or updating prior history.",
  parameters: cancelSubscriptionParameters,
  execute: async (_toolCallId, { name }) =>
    withDatabase("read-write", (db) => {
      const append = db.transaction(() => {
        const latest = latestSubscription(db, name);
        if (!latest) throw new Error(`サブスクが見つかりません: ${name}`);
        const inserted = db
          .prepare(
            `INSERT INTO subscriptions
               (name, amount, cycle, next_date, category, active, recorded_at)
             VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
          )
          .run(
            latest.name,
            latest.amount,
            latest.cycle,
            latest.next_date,
            latest.category,
          );
        return Number(inserted.lastInsertRowid);
      });
      const id = append();
      const snapshot = db
        .prepare<[number], SubscriptionRow>(
          `SELECT id, name, amount, cycle, next_date, category, active, recorded_at
           FROM subscriptions
           WHERE id = ?`,
        )
        .get(id);
      if (!snapshot) throw new Error("解約したサブスクを読み取れませんでした");
      const subscription = subscriptionFromRow(snapshot);
      return result(subscription, {
        operation: "cancel-subscription",
        subscription,
      });
    }),
};

const listSubscriptionsParameters = Type.Object({
  includeInactive: Type.Optional(
    Type.Boolean({
      description: "Include cancelled subscriptions; defaults to false.",
    }),
  ),
});

export const financeListSubscriptionsTool: AgentTool<
  typeof listSubscriptionsParameters
> = {
  name: "finance-list-subscriptions",
  label: "List Finance Subscriptions",
  description:
    "List the latest snapshot for each subscription name; active subscriptions are shown by default.",
  parameters: listSubscriptionsParameters,
  execute: async (_toolCallId, { includeInactive = false }) =>
    withDatabase("read-only", (db) => {
      const rows = db
        .prepare<[], SubscriptionRow>(
          `WITH current_subscriptions AS (
             SELECT s.*
             FROM subscriptions AS s
             JOIN (
               SELECT name, MAX(id) AS id
               FROM subscriptions
               GROUP BY name
             ) AS latest ON latest.id = s.id
           )
           SELECT id, name, amount, cycle, next_date, category, active, recorded_at
           FROM current_subscriptions
           ${includeInactive ? "" : "WHERE active = 1"}
           ORDER BY next_date ASC, name ASC`,
        )
        .all();
      const subscriptions = rows.map(subscriptionFromRow);
      return result(subscriptions, {
        operation: "list-subscriptions",
        count: subscriptions.length,
        includeInactive,
      });
    }),
};

const subscriptionHistoryParameters = Type.Object({
  name: Type.String({
    description:
      "Subscription logical identity whose snapshots should be listed.",
    minLength: 1,
    maxLength: 200,
  }),
});

export const financeSubscriptionHistoryTool: AgentTool<
  typeof subscriptionHistoryParameters
> = {
  name: "finance-subscription-history",
  label: "Finance Subscription History",
  description:
    "List every append-only snapshot for one subscription name in chronological order.",
  parameters: subscriptionHistoryParameters,
  execute: async (_toolCallId, { name }) =>
    withDatabase("read-only", (db) => {
      const rows = db
        .prepare<[string], SubscriptionRow>(
          `SELECT id, name, amount, cycle, next_date, category, active, recorded_at
           FROM subscriptions
           WHERE name = ?
           ORDER BY id ASC`,
        )
        .all(name);
      const history = rows.map(subscriptionFromRow);
      return result(history, {
        operation: "subscription-history",
        name,
        count: history.length,
      });
    }),
};

export const FINANCE_TOOLS = [
  financeRecordTransactionTool,
  financeListTransactionsTool,
  financeSummaryTool,
  financeAddSubscriptionTool,
  financeUpdateSubscriptionTool,
  financeCancelSubscriptionTool,
  financeListSubscriptionsTool,
  financeSubscriptionHistoryTool,
] as const;
