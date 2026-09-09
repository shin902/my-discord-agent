import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createFinanceTools } from "./finance.js";
import {
  getCapabilityDefinition,
  proxyCapabilityNames,
  resolveTools,
} from "./registry.js";

type ToolResult = Awaited<
  ReturnType<
    ReturnType<
      typeof createFinanceTools
    >["financeRecordTransactionTool"]["execute"]
  >
>;

type StoredSubscription = {
  id: number;
  name: string;
  amount: number;
  cycle: string;
  next_date: string;
  category: string | null;
  active: number;
  recorded_at: string | null;
};

const temporaryDirectories: string[] = [];

async function makeTools() {
  const directory = await mkdtemp(join(tmpdir(), "finance-tools-"));
  temporaryDirectories.push(directory);
  return createFinanceTools(join(directory, "finance.db"));
}

function details(result: ToolResult): Record<string, unknown> {
  return result.details as Record<string, unknown>;
}

function firstText(result: ToolResult): string {
  const first = result.content[0];
  if (!first || first.type !== "text") throw new Error("Expected text content");
  return first.text;
}

function readRows<T>(databasePath: string, sql: string): T[] {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("finance sandbox-local tools", () => {
  const toolNames = [
    "finance-record-transaction",
    "finance-list-transactions",
    "finance-summary",
    "finance-add-subscription",
    "finance-update-subscription",
    "finance-cancel-subscription",
    "finance-list-subscriptions",
    "finance-subscription-history",
  ] as const;

  it("registers all eight tools as sandbox capabilities, never Proxy capabilities", () => {
    expect(resolveTools([...toolNames]).map((tool) => tool.name)).toEqual([
      ...toolNames,
    ]);
    expect(proxyCapabilityNames([...toolNames])).toEqual([]);
    for (const name of toolNames) {
      expect(getCapabilityDefinition(name)).toMatchObject({
        tool: name,
        executor: "sandbox",
        factory: expect.any(Function),
      });
    }
  });

  it("keeps SQL and the database path out of the agent-facing contracts", () => {
    const tools = createFinanceTools();
    for (const tool of Object.values(tools)) {
      const contract = `${tool.description}\n${JSON.stringify(tool.parameters)}`;
      expect(contract).not.toMatch(
        /sqlite|\/workspace|finance\.db|SELECT |INSERT INTO|UPDATE .* SET|DELETE FROM/i,
      );
    }
  });

  it("initializes an empty database when a read tool is called", async () => {
    const tools = await makeTools();

    const result = await tools.financeListTransactionsTool.execute(
      "call-1",
      {},
    );

    expect(firstText(result)).toContain("取引一覧");
    expect(details(result)).toMatchObject({ count: 0 });
    const tables = readRows<{ name: string }>(
      join(temporaryDirectories[0], "finance.db"),
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect(tables.map((table) => table.name)).toEqual([
      "sqlite_sequence",
      "subscriptions",
      "transactions",
    ]);
  });

  it("stores income as positive and expense as negative, then lists and summarizes them", async () => {
    const tools = await makeTools();

    const income = await tools.financeRecordTransactionTool.execute("income", {
      date: "2026-09-01",
      amount: 250000,
      type: "income",
      category: "給与",
      description: "9月分",
    });
    const expense = await tools.financeRecordTransactionTool.execute(
      "expense",
      {
        date: "2026-09-02",
        amount: 800,
        type: "expense",
        category: "食費",
        description: "昼食",
      },
    );
    expect(details(income)).toMatchObject({ amount: 250000, type: "income" });
    expect(details(expense)).toMatchObject({ amount: -800, type: "expense" });

    const listed = await tools.financeListTransactionsTool.execute("list", {
      from: "2026-09-01",
      to: "2026-09-30",
      type: "expense",
    });
    expect(details(listed)).toMatchObject({ count: 1, type: "expense" });
    expect(details(listed).transactions).toEqual([
      expect.objectContaining({ date: "2026-09-02", amount: -800 }),
    ]);

    const summary = await tools.financeSummaryTool.execute("summary", {
      month: "2026-09",
    });
    expect(details(summary)).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-30",
      income: 250000,
      expense: -800,
      net: 249200,
    });
    expect(details(summary).categories).toEqual([
      { category: "食費", total: -800 },
    ]);
    expect(firstText(summary)).toContain("249,200");
  });

  it("preserves subscription compatibility and appends update/cancel snapshots", async () => {
    const tools = await makeTools();

    await tools.financeAddSubscriptionTool.execute("add", {
      name: "Netflix",
      amount: 1490,
      cycle: "monthly",
      nextDate: "2026-10-15",
      category: "エンタメ",
    });
    const updated = await tools.financeUpdateSubscriptionTool.execute(
      "update",
      {
        name: "Netflix",
        amount: 1800,
        nextDate: "2026-11-15",
      },
    );
    const cancelled = await tools.financeCancelSubscriptionTool.execute(
      "cancel",
      {
        name: "Netflix",
      },
    );

    expect(details(updated)).toMatchObject({
      amount: -1800,
      cycle: "monthly",
      next_date: "2026-11-15",
      active: 1,
    });
    expect(details(cancelled)).toMatchObject({ amount: -1800, active: 0 });

    const rows = readRows<StoredSubscription>(
      join(temporaryDirectories[0], "finance.db"),
      "SELECT id, name, amount, cycle, next_date, category, active, recorded_at FROM subscriptions ORDER BY id",
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.map(({ id, amount, next_date, active }) => ({
        id,
        amount,
        next_date,
        active,
      })),
    ).toEqual([
      { id: 1, amount: -1490, next_date: "2026-10-15", active: 1 },
      { id: 2, amount: -1800, next_date: "2026-11-15", active: 1 },
      { id: 3, amount: -1800, next_date: "2026-11-15", active: 0 },
    ]);
    expect(rows[0]).toMatchObject({ category: "エンタメ" });
    expect(rows[0].recorded_at).toEqual(expect.any(String));

    const current = await tools.financeListSubscriptionsTool.execute(
      "current",
      {},
    );
    expect(details(current)).toMatchObject({
      count: 0,
      includeInactive: false,
    });
    const allCurrent = await tools.financeListSubscriptionsTool.execute("all", {
      includeInactive: true,
    });
    expect(details(allCurrent)).toMatchObject({
      count: 1,
      includeInactive: true,
    });
    expect(details(allCurrent).subscriptions).toEqual([
      expect.objectContaining({ name: "Netflix", active: 0, amount: -1800 }),
    ]);

    const history = await tools.financeSubscriptionHistoryTool.execute(
      "history",
      {
        name: "Netflix",
      },
    );
    expect(details(history)).toMatchObject({ name: "Netflix", count: 3 });
    expect(
      (details(history).history as StoredSubscription[]).map((row) => row.id),
    ).toEqual([1, 2, 3]);
    expect(firstText(history)).toContain("解約済み");
  });

  it("adds recorded_at to legacy databases without rewriting legacy history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "finance-legacy-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "finance.db");
    const legacy = new Database(databasePath);
    legacy.exec(`
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
      VALUES ('Legacy', -500, 'monthly', '2026-10-01', 'Other', 1);
    `);
    legacy.close();

    const tools = createFinanceTools(databasePath);
    const history = await tools.financeSubscriptionHistoryTool.execute(
      "history",
      {
        name: "Legacy",
      },
    );

    expect((details(history).history as StoredSubscription[])[0]).toMatchObject(
      {
        id: 1,
        amount: -500,
        recorded_at: null,
      },
    );
    expect(
      readRows<{ name: string }>(
        databasePath,
        "PRAGMA table_info(subscriptions)",
      ).map((column) => column.name),
    ).toContain("recorded_at");

    await tools.financeUpdateSubscriptionTool.execute("update", {
      name: "Legacy",
      category: "Updated",
    });
    const rows = readRows<StoredSubscription>(
      databasePath,
      "SELECT id, name, amount, cycle, next_date, category, active, recorded_at FROM subscriptions ORDER BY id",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].recorded_at).toBeNull();
    expect(rows[1]).toMatchObject({
      category: "Updated",
      recorded_at: expect.any(String),
    });
  });
});
