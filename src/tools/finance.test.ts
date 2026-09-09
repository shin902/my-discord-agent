import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFinanceTools, FINANCE_TOOLS } from "./finance.js";
import { getCapabilityDefinition, resolveTools } from "./registry.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function testDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "finance-b-"));
  directories.push(directory);
  return join(directory, "finance.db");
}

function json<T>(result: {
  content: Array<{ type: string; text?: string }>;
}): T {
  const text = result.content.find((part) => part.type === "text")?.text;
  if (!text) throw new Error("finance tool returned no text");
  return JSON.parse(text) as T;
}

describe("finance sandbox tools", () => {
  it("registers exactly eight sandbox-local tools without proxy capabilities", () => {
    const names = FINANCE_TOOLS.map((tool) => tool.name);
    expect(names).toEqual([
      "finance-record-transaction",
      "finance-list-transactions",
      "finance-summary",
      "finance-add-subscription",
      "finance-update-subscription",
      "finance-cancel-subscription",
      "finance-list-subscriptions",
      "finance-subscription-history",
    ]);
    expect(resolveTools(names).map((tool) => tool.name)).toEqual(names);
    expect(names.map((name) => getCapabilityDefinition(name))).toEqual(
      names.map(() => undefined),
    );
    for (const tool of FINANCE_TOOLS) {
      expect(JSON.stringify(tool.parameters)).not.toMatch(
        /"(?:sql|path|database)"/i,
      );
    }
  });

  it("initializes the database and owns the income/expense sign convention", async () => {
    const dbPath = await testDatabase();
    const tools = createFinanceTools(dbPath);

    await tools.recordTransaction.execute("income", {
      type: "income",
      amount: 1000,
      date: "2026-09-10",
      category: "給与",
    });
    await tools.recordTransaction.execute("expense", {
      type: "expense",
      amount: 300,
      date: "2026-09-11",
      category: "食費",
    });

    const db = new Database(dbPath, { readonly: true });
    expect(
      db.prepare("SELECT amount FROM transactions ORDER BY id").pluck().all(),
    ).toEqual([1000, -300]);
    db.close();

    const listed = json<Array<{ type: string; amount: number }>>(
      await tools.listTransactions.execute("list", {}),
    );
    expect(listed).toMatchObject([
      { type: "expense", amount: -300 },
      { type: "income", amount: 1000 },
    ]);

    const summary = json<{
      income: number;
      expense: number;
      net: number;
      categories: Array<{ category: string; total: number }>;
    }>(
      await tools.summary.execute("summary", {
        from: "2026-09-01",
        to: "2026-09-30",
      }),
    );
    expect(summary).toMatchObject({ income: 1000, expense: -300, net: 700 });
    expect(summary.categories).toEqual([{ category: "食費", total: -300 }]);
  });

  it("filters transaction history without exposing SQL", async () => {
    const tools = createFinanceTools(await testDatabase());
    await tools.recordTransaction.execute("one", {
      type: "expense",
      amount: 100,
      date: "2026-08-31",
      category: "食費",
    });
    await tools.recordTransaction.execute("two", {
      type: "expense",
      amount: 200,
      date: "2026-09-01",
      category: "食費",
    });
    await tools.recordTransaction.execute("three", {
      type: "income",
      amount: 500,
      date: "2026-09-02",
      category: "給与",
    });

    const rows = json<Array<{ type: string; amount: number }>>(
      await tools.listTransactions.execute("list", {
        from: "2026-09-01",
        type: "expense",
      }),
    );
    expect(rows).toEqual([
      expect.objectContaining({ type: "expense", amount: -200 }),
    ]);
  });

  it("rejects invalid dates and reversed ranges", async () => {
    const tools = createFinanceTools(await testDatabase());
    await expect(
      tools.recordTransaction.execute("bad-date", {
        type: "expense",
        amount: 100,
        date: "2026-02-30",
      }),
    ).rejects.toThrow("date が不正な日付です");
    await expect(
      tools.listTransactions.execute("bad-range", {
        from: "2026-09-30",
        to: "2026-09-01",
      }),
    ).rejects.toThrow("from は to 以前の日付にしてください");
  });

  it("migrates a legacy database and keeps subscription changes append-only", async () => {
    const dbPath = await testDatabase();
    const legacy = new Database(dbPath);
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

    const tools = createFinanceTools(dbPath);
    await tools.updateSubscription.execute("update", {
      name: "Legacy",
      amount: 1200,
      nextDate: "2026-09-20",
    });
    await tools.cancelSubscription.execute("cancel", { name: "Legacy" });

    const db = new Database(dbPath, { readonly: true });
    const columns = db
      .prepare("PRAGMA table_info(subscriptions)")
      .all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain("recorded_at");
    expect(
      db
        .prepare(
          "SELECT amount, next_date, active FROM subscriptions ORDER BY id",
        )
        .all(),
    ).toEqual([
      { amount: -1000, next_date: "2026-09-15", active: 1 },
      { amount: -1200, next_date: "2026-09-20", active: 1 },
      { amount: -1200, next_date: "2026-09-20", active: 0 },
    ]);
    db.close();

    const history = json<Array<{ amount: number; active: boolean }>>(
      await tools.subscriptionHistory.execute("history", { name: "Legacy" }),
    );
    expect(history).toEqual([
      expect.objectContaining({ amount: 1000, active: true }),
      expect.objectContaining({ amount: 1200, active: true }),
      expect.objectContaining({ amount: 1200, active: false }),
    ]);

    expect(
      json<unknown[]>(await tools.listSubscriptions.execute("active", {})),
    ).toEqual([]);
    expect(
      json<Array<{ name: string; active: boolean }>>(
        await tools.listSubscriptions.execute("all", { includeInactive: true }),
      ),
    ).toEqual([expect.objectContaining({ name: "Legacy", active: false })]);
  });

  it("adds subscriptions and rejects empty updates", async () => {
    const tools = createFinanceTools(await testDatabase());
    const added = json<{ amount: number; active: boolean }>(
      await tools.addSubscription.execute("add", {
        name: "Example",
        amount: 980,
        cycle: "monthly",
        nextDate: "2026-09-30",
        category: "サービス",
      }),
    );
    expect(added).toMatchObject({ amount: 980, active: true });

    await expect(
      tools.updateSubscription.execute("empty", { name: "Example" }),
    ).rejects.toThrow("変更する項目を1つ以上指定してください");
  });
});
