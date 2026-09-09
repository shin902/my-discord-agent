import type { AgentTool } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";
import { Type } from "typebox";

const FINANCE_DATABASE_PATH = "/workspace/finance.db";
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const MONTH_PATTERN = "^\\d{4}-\\d{2}$";
const SUBSCRIPTION_CYCLES = ["monthly", "yearly", "weekly"] as const;
type SubscriptionCycle = (typeof SUBSCRIPTION_CYCLES)[number];
const TRANSACTION_TYPES = ["income", "expense"] as const;
type TransactionType = (typeof TRANSACTION_TYPES)[number];

const dateParameter = Type.String({
  description: "Date in YYYY-MM-DD format.",
  pattern: DATE_PATTERN,
});
const transactionTypeParameter = Type.Union([
  Type.Literal("income"),
  Type.Literal("expense"),
]);
const subscriptionCycleParameter = Type.Union([
  Type.Literal("monthly"),
  Type.Literal("yearly"),
  Type.Literal("weekly"),
]);

const recordTransactionParameters = Type.Object({
  amount: Type.Integer({
    description: "Positive amount in whole yen.",
    minimum: 1,
  }),
  type: transactionTypeParameter,
  date: Type.Optional(dateParameter),
  category: Type.Optional(
    Type.String({ description: "Category, kept exactly as provided." }),
  ),
  description: Type.Optional(Type.String({ description: "Transaction note." })),
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
  cycle: string;
  next_date: string;
  category: string | null;
  active: number;
  recorded_at: string | null;
};

type TableColumnRow = { name: string };

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT    NOT NULL,
      amount      INTEGER NOT NULL,
      category    TEXT,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      amount      INTEGER NOT NULL,
      cycle       TEXT    NOT NULL,
      next_date   TEXT    NOT NULL,
      category    TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const columns = db
    .prepare("PRAGMA table_info(subscriptions)")
    .all() as TableColumnRow[];
  if (!columns.some((column) => column.name === "recorded_at")) {
    // Legacy databases predate recorded_at. Keep existing rows untouched; new
    // snapshots receive the timestamp through the INSERT statement below.
    db.exec("ALTER TABLE subscriptions ADD COLUMN recorded_at TEXT");
  }
}

function openFinanceDatabase(databasePath: string): Database.Database {
  const db = new Database(databasePath);
  try {
    db.pragma("busy_timeout = 5000");
    createSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function withFinanceDatabase<T>(
  databasePath: string,
  callback: (db: Database.Database) => T,
): T {
  const db = openFinanceDatabase(databasePath);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function todayInAgentTimeZone(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} は YYYY-MM-DD 形式で指定してください`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${label} が実在する日付ではありません: ${value}`);
  }
}

function assertMonth(value: string): void {
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new Error("month は YYYY-MM 形式で指定してください");
  }
  const month = Number(value.slice(5));
  if (month < 1 || month > 12) {
    throw new Error(`month が不正です: ${value}`);
  }
}

function assertPositiveAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("amount は正の整数（円）で指定してください");
  }
}

function assertSubscriptionCycle(
  cycle: string,
): asserts cycle is SubscriptionCycle {
  if (!(SUBSCRIPTION_CYCLES as readonly string[]).includes(cycle)) {
    throw new Error(
      `cycle は ${SUBSCRIPTION_CYCLES.join(" / ")} のいずれかで指定してください`,
    );
  }
}

function assertTransactionType(type: string): asserts type is TransactionType {
  if (!(TRANSACTION_TYPES as readonly string[]).includes(type)) {
    throw new Error("type は income または expense で指定してください");
  }
}

function formatAmount(amount: number): string {
  const sign = amount >= 0 ? "+" : "-";
  return `${sign}${Math.abs(amount).toLocaleString("ja-JP")}円`;
}

function formatUnsignedAmount(amount: number): string {
  return `${Math.abs(amount).toLocaleString("ja-JP")}円`;
}

function transactionType(amount: number): TransactionType {
  return amount >= 0 ? "income" : "expense";
}

function cycleLabel(cycle: string): string {
  switch (cycle) {
    case "monthly":
      return "月額";
    case "yearly":
      return "年額";
    case "weekly":
      return "週額";
    default:
      return cycle;
  }
}

function subscriptionAmount(amount: number): number {
  return -Math.abs(amount);
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

function currentSubscriptions(db: Database.Database): SubscriptionRow[] {
  return db
    .prepare<[], SubscriptionRow>(
      `WITH latest AS (
         SELECT name, MAX(id) AS id
         FROM subscriptions
         GROUP BY name
       )
       SELECT s.id, s.name, s.amount, s.cycle, s.next_date,
              s.category, s.active, s.recorded_at
       FROM subscriptions AS s
       JOIN latest ON latest.id = s.id
       ORDER BY s.active DESC, s.next_date ASC, s.name ASC`,
    )
    .all();
}

function requireSubscriptionName(name: string): string {
  const normalized = name.trim();
  if (normalized.length === 0) {
    throw new Error("name は空にできません");
  }
  return normalized;
}

function rangeBounds(args: { from?: string; to?: string }): {
  from?: string;
  to?: string;
} {
  if (args.from !== undefined) assertDate(args.from, "from");
  if (args.to !== undefined) assertDate(args.to, "to");
  if (args.from !== undefined && args.to !== undefined && args.from > args.to) {
    throw new Error("from は to 以前の日付で指定してください");
  }
  return { from: args.from, to: args.to };
}

function formatTransactionLines(rows: TransactionRow[]): string[] {
  const lines: string[] = [];
  for (const transaction of rows) {
    lines.push(
      `### ${transaction.date} ${formatAmount(transaction.amount)}`,
      `- 種別: ${transactionType(transaction.amount)}`,
      `- カテゴリ: ${transaction.category ?? "未分類"}`,
      `- 内容: ${transaction.description ?? "(なし)"}`,
      "",
    );
  }
  return lines;
}

function formatSubscriptionLines(rows: SubscriptionRow[]): string[] {
  const lines: string[] = [];
  for (const subscription of rows) {
    lines.push(
      `### ${subscription.name}`,
      `- 金額: ${formatUnsignedAmount(subscription.amount)}`,
      `- 周期: ${cycleLabel(subscription.cycle)}`,
      `- 次回更新: ${subscription.next_date}`,
      `- カテゴリ: ${subscription.category ?? "未分類"}`,
      `- 状態: ${subscription.active === 1 ? "有効" : "解約済み"}`,
      "",
    );
  }
  return lines;
}

const listTransactionsParameters = Type.Object({
  from: Type.Optional(dateParameter),
  to: Type.Optional(dateParameter),
  type: Type.Optional(transactionTypeParameter),
  category: Type.Optional(Type.String({ description: "Category to filter." })),
  limit: Type.Optional(
    Type.Integer({
      description:
        "Maximum number of transactions. Defaults to 20; maximum 100.",
      minimum: 1,
      maximum: 100,
    }),
  ),
});

const summaryParameters = Type.Object({
  month: Type.Optional(
    Type.String({
      description:
        "Calendar month in YYYY-MM format. Defaults to the current month. Do not combine with from or to.",
      pattern: MONTH_PATTERN,
    }),
  ),
  from: Type.Optional(dateParameter),
  to: Type.Optional(dateParameter),
});

const addSubscriptionParameters = Type.Object({
  name: Type.String({ description: "Subscription name.", minLength: 1 }),
  amount: Type.Integer({
    description: "Positive recurring charge in whole yen.",
    minimum: 1,
  }),
  cycle: subscriptionCycleParameter,
  nextDate: Type.String({
    description: "Next renewal date in YYYY-MM-DD format.",
    pattern: DATE_PATTERN,
  }),
  category: Type.Optional(
    Type.String({ description: "Category, kept exactly as provided." }),
  ),
});

const updateSubscriptionParameters = Type.Object({
  name: Type.String({ description: "Subscription name.", minLength: 1 }),
  amount: Type.Optional(
    Type.Integer({
      description: "New positive recurring charge in whole yen.",
      minimum: 1,
    }),
  ),
  cycle: Type.Optional(subscriptionCycleParameter),
  nextDate: Type.Optional(
    Type.String({
      description: "New next renewal date in YYYY-MM-DD format.",
      pattern: DATE_PATTERN,
    }),
  ),
  category: Type.Optional(
    Type.String({ description: "New category, kept exactly as provided." }),
  ),
  active: Type.Optional(
    Type.Boolean({ description: "Whether the new snapshot is active." }),
  ),
});

const cancelSubscriptionParameters = Type.Object({
  name: Type.String({ description: "Subscription name.", minLength: 1 }),
});

const listSubscriptionsParameters = Type.Object({
  includeInactive: Type.Optional(
    Type.Boolean({
      description: "Include the latest inactive snapshot for each name.",
    }),
  ),
});

const subscriptionHistoryParameters = Type.Object({
  name: Type.String({ description: "Subscription name.", minLength: 1 }),
});

export function createFinanceTools(databasePath = FINANCE_DATABASE_PATH) {
  const financeRecordTransactionTool: AgentTool<
    typeof recordTransactionParameters
  > = {
    name: "finance-record-transaction",
    label: "Record Finance Transaction",
    description:
      "Record one income or expense. Provide a positive yen amount and choose income or expense; the tool stores the correct sign automatically.",
    parameters: recordTransactionParameters,
    execute: async (
      _toolCallId,
      { amount, type, date = todayInAgentTimeZone(), category, description },
    ) => {
      assertPositiveAmount(amount);
      assertTransactionType(type);
      assertDate(date, "date");
      const signedAmount = type === "income" ? amount : -amount;
      const transaction = withFinanceDatabase(databasePath, (db) => {
        const result = db
          .prepare(
            `INSERT INTO transactions (date, amount, category, description)
             VALUES (?, ?, ?, ?)`,
          )
          .run(date, signedAmount, category ?? null, description ?? null);
        return db
          .prepare<[number], TransactionRow>(
            `SELECT id, date, amount, category, description
             FROM transactions WHERE id = ?`,
          )
          .get(Number(result.lastInsertRowid));
      });
      if (!transaction) throw new Error("取引の記録を確認できませんでした");

      return {
        content: [
          {
            type: "text",
            text: [
              "取引を記録しました。",
              `- 日付: ${transaction.date}`,
              `- 種別: ${type}`,
              `- 金額: ${formatAmount(transaction.amount)}`,
              `- カテゴリ: ${transaction.category ?? "未分類"}`,
              `- 内容: ${transaction.description ?? "(なし)"}`,
            ].join("\n"),
          },
        ],
        details: {
          id: transaction.id,
          date: transaction.date,
          amount: transaction.amount,
          type,
          category: transaction.category,
          description: transaction.description,
        },
      };
    },
  };

  const financeListTransactionsTool: AgentTool<
    typeof listTransactionsParameters
  > = {
    name: "finance-list-transactions",
    label: "List Finance Transactions",
    description:
      "List recorded income and expenses, optionally filtered by date range, type, or category.",
    parameters: listTransactionsParameters,
    execute: async (_toolCallId, { from, to, type, category, limit = 20 }) => {
      const bounds = rangeBounds({ from, to });
      if (type !== undefined) assertTransactionType(type);
      const safeLimit = Math.min(limit, 100);
      const transactions = withFinanceDatabase(databasePath, (db) => {
        const conditions: string[] = [];
        const values: Array<string | number> = [];
        if (bounds.from !== undefined) {
          conditions.push("date >= ?");
          values.push(bounds.from);
        }
        if (bounds.to !== undefined) {
          conditions.push("date <= ?");
          values.push(bounds.to);
        }
        if (type === "income") conditions.push("amount > 0");
        if (type === "expense") conditions.push("amount < 0");
        if (category !== undefined) {
          conditions.push("category = ?");
          values.push(category);
        }
        const where =
          conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        return db
          .prepare(`SELECT id, date, amount, category, description
             FROM transactions
             ${where}
             ORDER BY date DESC, id DESC
             LIMIT ?`)
          .all(...values, safeLimit) as TransactionRow[];
      });

      const lines = [
        "## 取引一覧",
        "",
        ...formatTransactionLines(transactions),
      ];
      if (transactions.length === 0) lines.push("(取引はありません)");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: transactions.length,
          from: bounds.from,
          to: bounds.to,
          type,
          category,
          limit: safeLimit,
          transactions,
        },
      };
    },
  };

  const financeSummaryTool: AgentTool<typeof summaryParameters> = {
    name: "finance-summary",
    label: "Finance Summary",
    description:
      "Summarize income, expenses, net balance, and expense totals by category for a month or date range. The default is the current month.",
    parameters: summaryParameters,
    execute: async (_toolCallId, { month, from, to }) => {
      if (month !== undefined && (from !== undefined || to !== undefined)) {
        throw new Error("month と from/to は併用できません");
      }

      let bounds: { from: string; to: string };
      if (month !== undefined) {
        assertMonth(month);
        const [year, monthNumber] = month.split("-").map(Number);
        const lastDay = new Date(Date.UTC(year, monthNumber, 0));
        bounds = {
          from: `${month}-01`,
          to: `${month}-${String(lastDay.getUTCDate()).padStart(2, "0")}`,
        };
      } else if (from !== undefined || to !== undefined) {
        const validated = rangeBounds({ from, to });
        bounds = {
          from: validated.from ?? "0000-01-01",
          to: validated.to ?? "9999-12-31",
        };
      } else {
        const currentMonth = todayInAgentTimeZone().slice(0, 7);
        const [year, monthNumber] = currentMonth.split("-").map(Number);
        const lastDay = new Date(Date.UTC(year, monthNumber, 0));
        bounds = {
          from: `${currentMonth}-01`,
          to: `${currentMonth}-${String(lastDay.getUTCDate()).padStart(2, "0")}`,
        };
      }

      const summary = withFinanceDatabase(databasePath, (db) => {
        const totals = db
          .prepare<
            [string, string],
            {
              income: number | null;
              expense: number | null;
              net: number | null;
            }
          >(
            `SELECT
               SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
               SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expense,
               SUM(amount) AS net
             FROM transactions
             WHERE date BETWEEN ? AND ?`,
          )
          .get(bounds.from, bounds.to);
        const categories = db
          .prepare<
            [string, string],
            { category: string | null; total: number }
          >(
            `SELECT category, SUM(amount) AS total
             FROM transactions
             WHERE date BETWEEN ? AND ? AND amount < 0
             GROUP BY category
             ORDER BY total ASC`,
          )
          .all(bounds.from, bounds.to);
        const monthlyCost = db
          .prepare<[], { monthly_cost: number | null }>(
            `WITH latest AS (
               SELECT name, MAX(id) AS id
               FROM subscriptions
               GROUP BY name
             )
             SELECT SUM(
               CASE
                 WHEN s.cycle = 'monthly' THEN s.amount
                 WHEN s.cycle = 'yearly' THEN CAST(s.amount * 1.0 / 12 AS INTEGER)
                 WHEN s.cycle = 'weekly' THEN CAST(s.amount * 52.0 / 12 AS INTEGER)
                 ELSE s.amount
               END
             ) AS monthly_cost
             FROM subscriptions AS s
             JOIN latest ON latest.id = s.id
             WHERE s.active = 1 AND s.amount < 0`,
          )
          .get();
        return {
          income: totals?.income ?? 0,
          expense: totals?.expense ?? 0,
          net: totals?.net ?? 0,
          categories,
          monthlyCost: monthlyCost?.monthly_cost ?? null,
        };
      });

      const lines = [
        `## 収支サマリー（${bounds.from}〜${bounds.to}）`,
        "",
        `- 収入: ${formatAmount(summary.income)}`,
        `- 支出: ${formatAmount(summary.expense)}`,
        `- 収支: ${formatAmount(summary.net)}`,
      ];
      if (summary.categories.length > 0) {
        lines.push("", "### カテゴリ別支出");
        for (const category of summary.categories) {
          lines.push(
            `- ${category.category ?? "未分類"}: ${formatAmount(category.total)}`,
          );
        }
      }
      if (summary.monthlyCost !== null) {
        lines.push(
          "",
          `- 有効なサブスクの月額換算: ${formatAmount(summary.monthlyCost)}`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...summary, from: bounds.from, to: bounds.to },
      };
    },
  };

  const financeAddSubscriptionTool: AgentTool<
    typeof addSubscriptionParameters
  > = {
    name: "finance-add-subscription",
    label: "Add Finance Subscription",
    description:
      "Register a recurring subscription. Provide a positive charge; it is stored as an expense and the initial state remains in history.",
    parameters: addSubscriptionParameters,
    execute: async (
      _toolCallId,
      { name, amount, cycle, nextDate, category },
    ) => {
      const normalizedName = requireSubscriptionName(name);
      assertPositiveAmount(amount);
      assertSubscriptionCycle(cycle);
      assertDate(nextDate, "nextDate");
      const subscription = withFinanceDatabase(databasePath, (db) => {
        const result = db
          .prepare(
            `INSERT INTO subscriptions
               (name, amount, cycle, next_date, category, active, recorded_at)
             VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
          )
          .run(
            normalizedName,
            subscriptionAmount(amount),
            cycle,
            nextDate,
            category ?? null,
          );
        return (
          latestSubscription(db, normalizedName) ?? {
            id: Number(result.lastInsertRowid),
            name: normalizedName,
            amount: subscriptionAmount(amount),
            cycle,
            next_date: nextDate,
            category: category ?? null,
            active: 1,
            recorded_at: null,
          }
        );
      });

      return {
        content: [
          {
            type: "text",
            text: [
              "サブスクリプションを登録しました。",
              `- 名前: ${subscription.name}`,
              `- 金額: ${formatUnsignedAmount(subscription.amount)}`,
              `- 周期: ${cycleLabel(subscription.cycle)}`,
              `- 次回更新: ${subscription.next_date}`,
            ].join("\n"),
          },
        ],
        details: subscription,
      };
    },
  };

  const financeUpdateSubscriptionTool: AgentTool<
    typeof updateSubscriptionParameters
  > = {
    name: "finance-update-subscription",
    label: "Update Finance Subscription",
    description:
      "Create a new subscription snapshot with changed fields. Existing snapshots are never overwritten or deleted.",
    parameters: updateSubscriptionParameters,
    execute: async (
      _toolCallId,
      { name, amount, cycle, nextDate, category, active },
    ) => {
      const normalizedName = requireSubscriptionName(name);
      if (amount !== undefined) assertPositiveAmount(amount);
      if (cycle !== undefined) assertSubscriptionCycle(cycle);
      if (nextDate !== undefined) assertDate(nextDate, "nextDate");

      const subscription = withFinanceDatabase(databasePath, (db) => {
        const append = db.transaction(() => {
          const current = latestSubscription(db, normalizedName);
          if (!current) {
            throw new Error(
              `サブスクリプションが見つかりません: ${normalizedName}`,
            );
          }
          db.prepare(
            `INSERT INTO subscriptions
               (name, amount, cycle, next_date, category, active, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          ).run(
            current.name,
            amount === undefined ? current.amount : subscriptionAmount(amount),
            cycle ?? current.cycle,
            nextDate ?? current.next_date,
            category ?? current.category,
            active === undefined ? current.active : active ? 1 : 0,
          );
          return latestSubscription(db, normalizedName);
        });
        return append();
      });
      if (!subscription) throw new Error("更新後の状態を確認できませんでした");

      return {
        content: [
          {
            type: "text",
            text: [
              "サブスクリプションを更新しました（履歴へ新しい状態を追加）。",
              `- 名前: ${subscription.name}`,
              `- 金額: ${formatUnsignedAmount(subscription.amount)}`,
              `- 周期: ${cycleLabel(subscription.cycle)}`,
              `- 次回更新: ${subscription.next_date}`,
              `- 状態: ${subscription.active === 1 ? "有効" : "解約済み"}`,
            ].join("\n"),
          },
        ],
        details: subscription,
      };
    },
  };

  const financeCancelSubscriptionTool: AgentTool<
    typeof cancelSubscriptionParameters
  > = {
    name: "finance-cancel-subscription",
    label: "Cancel Finance Subscription",
    description:
      "Mark a subscription as cancelled by appending an inactive snapshot. Existing snapshots are never overwritten or deleted.",
    parameters: cancelSubscriptionParameters,
    execute: async (_toolCallId, { name }) => {
      const normalizedName = requireSubscriptionName(name);
      const subscription = withFinanceDatabase(databasePath, (db) => {
        const append = db.transaction(() => {
          const current = latestSubscription(db, normalizedName);
          if (!current) {
            throw new Error(
              `サブスクリプションが見つかりません: ${normalizedName}`,
            );
          }
          db.prepare(
            `INSERT INTO subscriptions
               (name, amount, cycle, next_date, category, active, recorded_at)
             VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`,
          ).run(
            current.name,
            current.amount,
            current.cycle,
            current.next_date,
            current.category,
          );
          return latestSubscription(db, normalizedName);
        });
        return append();
      });
      if (!subscription) throw new Error("解約後の状態を確認できませんでした");

      return {
        content: [
          {
            type: "text",
            text: `サブスクリプションを解約しました: ${subscription.name}`,
          },
        ],
        details: subscription,
      };
    },
  };

  const financeListSubscriptionsTool: AgentTool<
    typeof listSubscriptionsParameters
  > = {
    name: "finance-list-subscriptions",
    label: "List Finance Subscriptions",
    description:
      "List the latest state for each subscription name. Active subscriptions are returned by default; optionally include inactive latest states.",
    parameters: listSubscriptionsParameters,
    execute: async (_toolCallId, { includeInactive = false }) => {
      const allCurrent = withFinanceDatabase(
        databasePath,
        currentSubscriptions,
      );
      const subscriptions = includeInactive
        ? allCurrent
        : allCurrent.filter((subscription) => subscription.active === 1);
      const lines = [
        `## サブスクリプション一覧（${includeInactive ? "全状態" : "有効のみ"}）`,
        "",
        ...formatSubscriptionLines(subscriptions),
      ];
      if (subscriptions.length === 0)
        lines.push("(サブスクリプションはありません)");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          count: subscriptions.length,
          includeInactive,
          subscriptions,
        },
      };
    },
  };

  const financeSubscriptionHistoryTool: AgentTool<
    typeof subscriptionHistoryParameters
  > = {
    name: "finance-subscription-history",
    label: "Finance Subscription History",
    description:
      "Show every append-only snapshot for one subscription name in creation order, including cancelled and older states.",
    parameters: subscriptionHistoryParameters,
    execute: async (_toolCallId, { name }) => {
      const normalizedName = requireSubscriptionName(name);
      const history = withFinanceDatabase(databasePath, (db) =>
        db
          .prepare<[string], SubscriptionRow>(
            `SELECT id, name, amount, cycle, next_date, category, active, recorded_at
             FROM subscriptions
             WHERE name = ?
             ORDER BY id ASC`,
          )
          .all(normalizedName),
      );
      const lines = [`## サブスクリプション履歴（${normalizedName}）`, ""];
      for (const snapshot of history) {
        lines.push(
          `### #${snapshot.id} ${snapshot.recorded_at ?? "記録時刻なし"}`,
          `- 金額: ${formatUnsignedAmount(snapshot.amount)}`,
          `- 周期: ${cycleLabel(snapshot.cycle)}`,
          `- 次回更新: ${snapshot.next_date}`,
          `- カテゴリ: ${snapshot.category ?? "未分類"}`,
          `- 状態: ${snapshot.active === 1 ? "有効" : "解約済み"}`,
          "",
        );
      }
      if (history.length === 0) lines.push("(履歴はありません)");
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { name: normalizedName, count: history.length, history },
      };
    },
  };

  return {
    financeRecordTransactionTool,
    financeListTransactionsTool,
    financeSummaryTool,
    financeAddSubscriptionTool,
    financeUpdateSubscriptionTool,
    financeCancelSubscriptionTool,
    financeListSubscriptionsTool,
    financeSubscriptionHistoryTool,
  };
}

const defaultFinanceTools = createFinanceTools();

export const {
  financeRecordTransactionTool,
  financeListTransactionsTool,
  financeSummaryTool,
  financeAddSubscriptionTool,
  financeUpdateSubscriptionTool,
  financeCancelSubscriptionTool,
  financeListSubscriptionsTool,
  financeSubscriptionHistoryTool,
} = defaultFinanceTools;
