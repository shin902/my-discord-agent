import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeFinanceOperation } from "./finance-cli.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp("/tmp/finance-cli-test-");
  directories.push(directory);
  return join(directory, "finance.db");
}

async function run(dbPath: string, operation: string, input: unknown) {
  const text = await executeFinanceOperation(
    [operation, JSON.stringify(input)],
    dbPath,
  );
  return JSON.parse(text) as unknown;
}

describe("finance-cli", () => {
  it("supports help without opening a database", async () => {
    await expect(executeFinanceOperation(["--help"])).resolves.toContain(
      "finance-record-transaction",
    );
  });

  it("reuses all eight existing Finance Tool operations", async () => {
    const dbPath = await databasePath();
    await run(dbPath, "finance-record-transaction", {
      type: "income",
      amount: 1000,
      date: "2026-09-10",
      category: "salary",
    });
    await run(dbPath, "finance-record-transaction", {
      type: "expense",
      amount: 300,
      date: "2026-09-11",
      category: "food",
    });

    expect(
      await run(dbPath, "finance-list-transactions", { type: "expense" }),
    ).toMatchObject([{ type: "expense", amount: -300 }]);
    expect(
      await run(dbPath, "finance-summary", {
        from: "2026-09-01",
        to: "2026-09-30",
      }),
    ).toMatchObject({ income: 1000, expense: -300, net: 700 });

    await run(dbPath, "finance-add-subscription", {
      name: "Example",
      amount: 980,
      cycle: "monthly",
      nextDate: "2026-09-30",
    });
    await run(dbPath, "finance-update-subscription", {
      name: "Example",
      amount: 1200,
    });
    expect(await run(dbPath, "finance-list-subscriptions", {})).toMatchObject([
      { name: "Example", amount: 1200, active: true },
    ]);
    expect(
      await run(dbPath, "finance-subscription-history", { name: "Example" }),
    ).toHaveLength(2);
    await run(dbPath, "finance-cancel-subscription", { name: "Example" });
    expect(
      await run(dbPath, "finance-list-subscriptions", {
        includeInactive: true,
      }),
    ).toMatchObject([{ name: "Example", active: false }]);
  });

  it("keeps schema and unknown-operation failures fail-closed", async () => {
    const dbPath = await databasePath();
    await expect(
      executeFinanceOperation(
        [
          "finance-record-transaction",
          JSON.stringify({ type: "expense", amount: 0 }),
        ],
        dbPath,
      ),
    ).rejects.toThrow("Invalid arguments for tool: finance-record-transaction");
    await expect(
      executeFinanceOperation(["unknown", "{}"], dbPath),
    ).rejects.toThrow("Unknown finance operation");
  });
});
