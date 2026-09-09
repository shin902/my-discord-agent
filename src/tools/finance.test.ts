import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINANCE_TOOLS,
  financeAddSubscriptionTool,
  financeCancelSubscriptionTool,
  financeListSubscriptionsTool,
  financeListTransactionsTool,
  financeRecordTransactionTool,
  financeSubscriptionHistoryTool,
  financeSummaryTool,
  financeUpdateSubscriptionTool,
} from "./finance.js";
import {
  ensureFinanceDatabase,
  FINANCE_RUNTIME_DB_PATH,
} from "./finance-db.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function database(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "finance-tools-"));
  directories.push(directory);
  const path = join(directory, "finance.db");
  vi.stubEnv("FINANCE_DB_PATH", path);
  return path;
}

function text(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const part = result.content.find((content) => content.type === "text");
  if (!part?.text) throw new Error("Finance tool returned no text");
  return part.text;
}

function json<T>(result: {
  content: Array<{ type: string; text?: string }>;
}): T {
  return JSON.parse(text(result)) as T;
}

describe("finance runtime tools", () => {
  it("registers exactly the eight purpose-specific tools without storage controls", () => {
    expect(FINANCE_TOOLS.map((tool) => tool.name)).toEqual([
      "finance-record-transaction",
      "finance-list-transactions",
      "finance-summary",
      "finance-add-subscription",
      "finance-update-subscription",
      "finance-cancel-subscription",
      "finance-list-subscriptions",
      "finance-subscription-history",
    ]);
    for (const tool of FINANCE_TOOLS) {
      const schema = JSON.stringify(tool.parameters);
      expect(schema).not.toMatch(
        /"(?:sql|database|path|mount|runtime|image)"/i,
      );
    }
    expect(FINANCE_RUNTIME_DB_PATH).toBe("/var/lib/finance/finance.db");
  });

  it("stores income as positive and expense as negative from positive inputs", async () => {
    const path = await database();
    const income = await financeRecordTransactionTool.execute("income", {
      type: "income",
      amount: 250_000,
      date: "2026-09-10",
      category: "給与",
      description: "9月分",
    });
    const expense = await financeRecordTransactionTool.execute("expense", {
      type: "expense",
      amount: 800,
      date: "2026-09-10",
      category: "食費",
      description: "コンビニ",
    });

    expect(json<{ amount: number; type: string }>(income)).toMatchObject({
      amount: 250_000,
      type: "income",
    });
    expect(json<{ amount: number; type: string }>(expense)).toMatchObject({
      amount: -800,
      type: "expense",
    });
    const db = new Database(path, { readonly: true });
    expect(
      db.prepare("SELECT amount FROM transactions ORDER BY id").pluck().all(),
    ).toEqual([250_000, -800]);
    db.close();
  });

  it("keeps legacy rows, migrates recorded_at, and appends subscription updates/cancellation", async () => {
    const path = await database();
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        amount INTEGER NOT NULL,
        category TEXT,
        description TEXT
      );
      CREATE TABLE subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        amount INTEGER NOT NULL,
        cycle TEXT NOT NULL,
        next_date TEXT NOT NULL,
        category TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO subscriptions
        (name, amount, cycle, next_date, category, active)
      VALUES ('Legacy', -1000, 'monthly', '2026-09-15', '旧', 1);
    `);
    legacy.close();

    ensureFinanceDatabase(path);
    const added = await financeAddSubscriptionTool.execute("add", {
      name: "Legacy",
      amount: 1200,
      cycle: "monthly",
      nextDate: "2026-09-20",
      category: "新",
    });
    await financeUpdateSubscriptionTool.execute("update", {
      name: "Legacy",
      amount: 1500,
    });
    await financeCancelSubscriptionTool.execute("cancel", {
      name: "Legacy",
    });

    const db = new Database(path, { readonly: true });
    expect(
      (
        db.prepare("PRAGMA table_info(subscriptions)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    ).toContain("recorded_at");
    expect(
      db
        .prepare(
          "SELECT amount, cycle, next_date, category, active FROM subscriptions ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        amount: -1000,
        cycle: "monthly",
        next_date: "2026-09-15",
        category: "旧",
        active: 1,
      },
      {
        amount: -1200,
        cycle: "monthly",
        next_date: "2026-09-20",
        category: "新",
        active: 1,
      },
      {
        amount: -1500,
        cycle: "monthly",
        next_date: "2026-09-20",
        category: "新",
        active: 1,
      },
      {
        amount: -1500,
        cycle: "monthly",
        next_date: "2026-09-20",
        category: "新",
        active: 0,
      },
    ]);
    db.close();

    expect(json<{ amount: number }>(added)).toMatchObject({ amount: 1200 });
    expect(
      json<Array<{ name: string }>>(
        await financeListSubscriptionsTool.execute("list", {}),
      ),
    ).toEqual([]);
    expect(
      json<Array<{ amount: number; active: boolean }>>(
        await financeListSubscriptionsTool.execute("all", {
          includeInactive: true,
        }),
      ),
    ).toHaveLength(1);
    expect(
      json<Array<{ amount: number; active: boolean }>>(
        await financeSubscriptionHistoryTool.execute("history", {
          name: "Legacy",
        }),
      ),
    ).toEqual([
      expect.objectContaining({ amount: 1000, active: true }),
      expect.objectContaining({ amount: 1200, active: true }),
      expect.objectContaining({ amount: 1500, active: true }),
      expect.objectContaining({ amount: 1500, active: false }),
    ]);
  });

  it("lists filtered transactions and summarizes the current month range", async () => {
    await database();
    await financeRecordTransactionTool.execute("one", {
      type: "income",
      amount: 1000,
      date: "2026-09-02",
      category: "給与",
    });
    await financeRecordTransactionTool.execute("two", {
      type: "expense",
      amount: 300,
      date: "2026-09-03",
      category: "食費",
    });
    await financeRecordTransactionTool.execute("three", {
      type: "expense",
      amount: 200,
      date: "2026-08-31",
      category: "食費",
    });

    const transactions = json<Array<{ amount: number }>>(
      await financeListTransactionsTool.execute("list", {
        from: "2026-09-01",
        to: "2026-09-30",
        type: "expense",
      }),
    );
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.amount).toBe(-300);

    const summary = json<{
      income: number;
      expense: number;
      net: number;
      categories: Array<{ category: string; total: number }>;
    }>(
      await financeSummaryTool.execute("summary", {
        from: "2026-09-01",
        to: "2026-09-30",
      }),
    );
    expect(summary).toMatchObject({ income: 1000, expense: -300, net: 700 });
    expect(summary.categories).toEqual([{ category: "食費", total: -300 }]);
  });
});
