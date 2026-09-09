import type { AgentTool } from "@earendil-works/pi-agent-core";
import type Database from "better-sqlite3";
import { Type } from "typebox";
import { formatCurrentDateTime } from "../time/context.js";
import { withFinanceDatabase } from "./finance-db.js";

export const FINANCE_DATABASE_PATH = "/workspace/finance.db";

const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const amount = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const category = Type.Optional(Type.String({ maxLength: 200 }));
const cycle = Type.Union([
  Type.Literal("monthly"),
  Type.Literal("yearly"),
  Type.Literal("weekly"),
]);
const transactionType = Type.Union([
  Type.Literal("income"),
  Type.Literal("expense"),
]);
const optionalDate = Type.Optional(Type.String({ pattern: DATE_PATTERN }));

const recordTransactionParameters = Type.Object({
  type: transactionType,
  amount,
  date: optionalDate,
  category,
  description: Type.Optional(Type.String({ maxLength: 2000 })),
});

const listTransactionsParameters = Type.Object({
  from: optionalDate,
  to: optionalDate,
  category,
  type: Type.Optional(transactionType),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

const summaryParameters = Type.Object({
  from: optionalDate,
  to: optionalDate,
});

const addSubscriptionParameters = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  amount,
  cycle,
  nextDate: Type.String({ pattern: DATE_PATTERN }),
  category,
});

const updateSubscriptionParameters = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
  amount: Type.Optional(amount),
  cycle: Type.Optional(cycle),
  nextDate: optionalDate,
  category: Type.Optional(
    Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  ),
  active: Type.Optional(Type.Boolean()),
});

const subscriptionNameParameters = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 200 }),
});

const listSubscriptionsParameters = Type.Object({
  includeInactive: Type.Optional(Type.Boolean()),
});

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
  cycle: "monthly" | "yearly" | "weekly";
  next_date: string;
  category: string | null;
  active: number;
  recorded_at: string | null;
};

type SubscriptionState = Omit<SubscriptionRow, "id" | "recorded_at">;

function currentDate(): string {
  return formatCurrentDateTime(Date.now()).slice(0, 10);
}

function currentMonthRange(): { from: string; to: string } {
  const today = currentDate();
  const [year, month] = today.split("-");
  return {
    from: `${year}-${month}-01`,
    to: new Date(Date.UTC(Number(year), Number(month), 0))
      .toISOString()
      .slice(0, 10),
  };
}

function assertDate(value: string, label: string): void {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !new RegExp(DATE_PATTERN).test(value) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} が不正な日付です: ${value}`);
  }
}

function assertDateRange(from?: string, to?: string): void {
  if (from) assertDate(from, "from");
  if (to) assertDate(to, "to");
  if (from && to && from > to) {
    throw new Error("from は to 以前の日付にしてください");
  }
}

function assertAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("amount は正の整数で指定してください");
  }
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function publicTransaction(row: TransactionRow) {
  return {
    id: row.id,
    date: row.date,
    type: row.amount < 0 ? ("expense" as const) : ("income" as const),
    amount: row.amount,
    category: row.category,
    description: row.description,
  };
}

function publicSubscription(row: SubscriptionRow) {
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

function latestSubscription(
  db: Database.Database,
  name: string,
): SubscriptionRow | undefined {
  return db
    .prepare(
      `SELECT id, name, amount, cycle, next_date, category, active, recorded_at
       FROM subscriptions WHERE name = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(name) as SubscriptionRow | undefined;
}

function insertSubscription(
  db: Database.Database,
  state: SubscriptionState,
): SubscriptionRow {
  const inserted = db
    .prepare(
      `INSERT INTO subscriptions
       (name, amount, cycle, next_date, category, active, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .run(
      state.name,
      state.amount,
      state.cycle,
      state.next_date,
      state.category,
      state.active,
    );
  return db
    .prepare(
      `SELECT id, name, amount, cycle, next_date, category, active, recorded_at
       FROM subscriptions WHERE id = ?`,
    )
    .get(Number(inserted.lastInsertRowid)) as SubscriptionRow;
}

export function createFinanceTools(dbPath = FINANCE_DATABASE_PATH) {
  const recordTransaction: AgentTool<typeof recordTransactionParameters> = {
    name: "finance-record-transaction",
    label: "Record Finance Transaction",
    description: "Record one income or expense in yen.",
    parameters: recordTransactionParameters,
    execute: async (_id, input) => {
      assertAmount(input.amount);
      const date = input.date ?? currentDate();
      assertDate(date, "date");
      return withFinanceDatabase(dbPath, (db) => {
        const signed = input.type === "expense" ? -input.amount : input.amount;
        const inserted = db
          .prepare(
            `INSERT INTO transactions (date, amount, category, description)
             VALUES (?, ?, ?, ?)`,
          )
          .run(date, signed, input.category ?? null, input.description ?? null);
        const row = db
          .prepare(
            `SELECT id, date, amount, category, description
             FROM transactions WHERE id = ?`,
          )
          .get(Number(inserted.lastInsertRowid)) as TransactionRow;
        return result(publicTransaction(row));
      });
    },
  };

  const listTransactions: AgentTool<typeof listTransactionsParameters> = {
    name: "finance-list-transactions",
    label: "List Finance Transactions",
    description: "List income and expenses with optional filters.",
    parameters: listTransactionsParameters,
    execute: async (_id, input) => {
      assertDateRange(input.from, input.to);
      return withFinanceDatabase(dbPath, (db) => {
        const where: string[] = [];
        const values: Array<string | number> = [];
        if (input.from) {
          where.push("date >= ?");
          values.push(input.from);
        }
        if (input.to) {
          where.push("date <= ?");
          values.push(input.to);
        }
        if (input.category !== undefined) {
          where.push("category = ?");
          values.push(input.category);
        }
        if (input.type === "income") where.push("amount > 0");
        if (input.type === "expense") where.push("amount < 0");
        values.push(input.limit ?? 50);
        const rows = db
          .prepare(
            `SELECT id, date, amount, category, description
             FROM transactions
             ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY date DESC, id DESC LIMIT ?`,
          )
          .all(...values) as TransactionRow[];
        return result(rows.map(publicTransaction));
      });
    },
  };

  const summary: AgentTool<typeof summaryParameters> = {
    name: "finance-summary",
    label: "Finance Summary",
    description:
      "Summarize income, expenses, net balance, and expense totals by category.",
    parameters: summaryParameters,
    execute: async (_id, input) => {
      const defaultRange =
        input.from || input.to ? undefined : currentMonthRange();
      const from = input.from ?? defaultRange?.from;
      const to = input.to ?? defaultRange?.to;
      assertDateRange(from, to);
      return withFinanceDatabase(dbPath, (db) => {
        const where: string[] = [];
        const values: string[] = [];
        if (from) {
          where.push("date >= ?");
          values.push(from);
        }
        if (to) {
          where.push("date <= ?");
          values.push(to);
        }
        const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
        const totals = db
          .prepare(
            `SELECT
               SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
               SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expense,
               SUM(amount) AS net
             FROM transactions ${clause}`,
          )
          .get(...values) as {
          income: number | null;
          expense: number | null;
          net: number | null;
        };
        const categories = db
          .prepare(
            `SELECT category, SUM(amount) AS total
             FROM transactions ${clause}${clause ? " AND" : "WHERE"} amount < 0
             GROUP BY category ORDER BY total ASC`,
          )
          .all(...values) as Array<{ category: string | null; total: number }>;
        return result({
          from,
          to,
          income: totals.income ?? 0,
          expense: totals.expense ?? 0,
          net: totals.net ?? 0,
          categories,
        });
      });
    },
  };

  const addSubscription: AgentTool<typeof addSubscriptionParameters> = {
    name: "finance-add-subscription",
    label: "Add Finance Subscription",
    description: "Add a subscription as a new state snapshot.",
    parameters: addSubscriptionParameters,
    execute: async (_id, input) => {
      assertAmount(input.amount);
      assertDate(input.nextDate, "nextDate");
      return withFinanceDatabase(dbPath, (db) =>
        result(
          publicSubscription(
            insertSubscription(db, {
              name: input.name,
              amount: -input.amount,
              cycle: input.cycle,
              next_date: input.nextDate,
              category: input.category ?? null,
              active: 1,
            }),
          ),
        ),
      );
    },
  };

  const updateSubscription: AgentTool<typeof updateSubscriptionParameters> = {
    name: "finance-update-subscription",
    label: "Update Finance Subscription",
    description:
      "Append a changed subscription snapshot without rewriting history.",
    parameters: updateSubscriptionParameters,
    execute: async (_id, input) => {
      if (input.amount !== undefined) assertAmount(input.amount);
      if (input.nextDate !== undefined) assertDate(input.nextDate, "nextDate");
      if (
        input.amount === undefined &&
        input.cycle === undefined &&
        input.nextDate === undefined &&
        input.category === undefined &&
        input.active === undefined
      ) {
        throw new Error("変更する項目を1つ以上指定してください");
      }
      return withFinanceDatabase(dbPath, (db) => {
        const append = db.transaction(() => {
          const previous = latestSubscription(db, input.name);
          if (!previous)
            throw new Error(`サブスクが見つかりません: ${input.name}`);
          return insertSubscription(db, {
            name: previous.name,
            amount:
              input.amount === undefined ? previous.amount : -input.amount,
            cycle: input.cycle ?? previous.cycle,
            next_date: input.nextDate ?? previous.next_date,
            category:
              input.category === undefined ? previous.category : input.category,
            active:
              input.active === undefined
                ? previous.active
                : input.active
                  ? 1
                  : 0,
          });
        });
        return result(publicSubscription(append()));
      });
    },
  };

  const cancelSubscription: AgentTool<typeof subscriptionNameParameters> = {
    name: "finance-cancel-subscription",
    label: "Cancel Finance Subscription",
    description: "Append an inactive snapshot instead of deleting history.",
    parameters: subscriptionNameParameters,
    execute: async (_id, input) =>
      withFinanceDatabase(dbPath, (db) => {
        const append = db.transaction(() => {
          const previous = latestSubscription(db, input.name);
          if (!previous)
            throw new Error(`サブスクが見つかりません: ${input.name}`);
          return insertSubscription(db, {
            name: previous.name,
            amount: previous.amount,
            cycle: previous.cycle,
            next_date: previous.next_date,
            category: previous.category,
            active: 0,
          });
        });
        return result(publicSubscription(append()));
      }),
  };

  const listSubscriptions: AgentTool<typeof listSubscriptionsParameters> = {
    name: "finance-list-subscriptions",
    label: "List Finance Subscriptions",
    description: "List the latest snapshot for each subscription.",
    parameters: listSubscriptionsParameters,
    execute: async (_id, input) =>
      withFinanceDatabase(dbPath, (db) => {
        const rows = db
          .prepare(
            `WITH latest AS (
               SELECT name, MAX(id) AS id FROM subscriptions GROUP BY name
             )
             SELECT s.id, s.name, s.amount, s.cycle, s.next_date,
                    s.category, s.active, s.recorded_at
             FROM subscriptions s JOIN latest ON latest.id = s.id
             ${input.includeInactive ? "" : "WHERE s.active = 1"}
             ORDER BY s.next_date ASC, s.name ASC`,
          )
          .all() as SubscriptionRow[];
        return result(rows.map(publicSubscription));
      }),
  };

  const subscriptionHistory: AgentTool<typeof subscriptionNameParameters> = {
    name: "finance-subscription-history",
    label: "Finance Subscription History",
    description: "List every stored snapshot for one subscription.",
    parameters: subscriptionNameParameters,
    execute: async (_id, input) =>
      withFinanceDatabase(dbPath, (db) => {
        const rows = db
          .prepare(
            `SELECT id, name, amount, cycle, next_date, category, active, recorded_at
             FROM subscriptions WHERE name = ? ORDER BY id ASC`,
          )
          .all(input.name) as SubscriptionRow[];
        return result(rows.map(publicSubscription));
      }),
  };

  return {
    recordTransaction,
    listTransactions,
    summary,
    addSubscription,
    updateSubscription,
    cancelSubscription,
    listSubscriptions,
    subscriptionHistory,
  };
}

export const financeTools = createFinanceTools();
export const FINANCE_TOOLS = Object.values(financeTools);
