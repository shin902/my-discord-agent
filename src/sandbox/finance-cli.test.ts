import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { executeFinanceOperation } from "./finance-cli.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "finance-cli-test-"));
  directories.push(directory);
  return join(directory, "finance.db");
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function run<T>(
  dbPath: string,
  operation: string,
  input: unknown,
): Promise<T> {
  const output = await executeFinanceOperation(
    [operation, JSON.stringify(input)],
    dbPath,
  );
  return JSON.parse(output) as T;
}

describe("finance-cli bridge", () => {
  it("provides help without opening the database", async () => {
    const dbPath = await databasePath();
    await expect(
      executeFinanceOperation(["--help"], dbPath),
    ).resolves.toContain("finance-record-transaction");
    await expect(rm(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("dispatches all eight operations to the existing Finance Tools", async () => {
    const dbPath = await databasePath();

    expect(
      await run(dbPath, "finance-record-transaction", {
        type: "income",
        amount: 1000,
        date: "2026-09-10",
        category: "salary",
      }),
    ).toMatchObject({ type: "income", amount: 1000 });
    expect(
      await run(dbPath, "finance-list-transactions", { type: "income" }),
    ).toMatchObject([{ type: "income", amount: 1000 }]);
    expect(
      await run(dbPath, "finance-summary", {
        from: "2026-09-01",
        to: "2026-09-30",
      }),
    ).toMatchObject({ income: 1000, expense: 0, net: 1000 });
    expect(
      await run(dbPath, "finance-add-subscription", {
        name: "Example",
        amount: 980,
        cycle: "monthly",
        nextDate: "2026-09-30",
      }),
    ).toMatchObject({ name: "Example", amount: 980, active: true });
    expect(
      await run(dbPath, "finance-update-subscription", {
        name: "Example",
        amount: 1200,
      }),
    ).toMatchObject({ name: "Example", amount: 1200, active: true });
    expect(
      await run(dbPath, "finance-cancel-subscription", { name: "Example" }),
    ).toMatchObject({ name: "Example", amount: 1200, active: false });
    expect(
      await run(dbPath, "finance-list-subscriptions", {
        includeInactive: true,
      }),
    ).toMatchObject([{ name: "Example", amount: 1200, active: false }]);
    expect(
      await run(dbPath, "finance-subscription-history", { name: "Example" }),
    ).toMatchObject([
      { name: "Example", amount: 980, active: true },
      { name: "Example", amount: 1200, active: true },
      { name: "Example", amount: 1200, active: false },
    ]);
  });

  it("keeps existing schema validation and bridge errors fail-closed", async () => {
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
      executeFinanceOperation(
        [
          "finance-update-subscription",
          JSON.stringify({ name: "Example", active: "false" }),
        ],
        dbPath,
      ),
    ).rejects.toThrow(
      "Invalid arguments for tool: finance-update-subscription",
    );
    await expect(
      executeFinanceOperation(
        ["finance-record-transaction", "not-json"],
        dbPath,
      ),
    ).rejects.toThrow("Finance CLI arguments must be valid JSON");
    await expect(
      executeFinanceOperation(["unknown", "{}"], dbPath),
    ).rejects.toThrow("Unknown finance operation");
    await expect(rm(dbPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs main from the bundled CLI through a finance-cli symlink", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".finance-cli-test-"));
    directories.push(directory);
    const bundlePath = join(directory, "finance-cli.bundle.mjs");
    const linkPath = join(directory, "finance-cli");
    const entrypoint = fileURLToPath(
      new URL("./finance-cli.ts", import.meta.url),
    );

    await build({
      entryPoints: [entrypoint],
      outfile: bundlePath,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      external: ["better-sqlite3"],
    });
    await chmod(bundlePath, 0o755);
    await symlink(bundlePath, linkPath);

    const { stdout } = await execFileAsync(process.execPath, [
      linkPath,
      "--help",
    ]);
    expect(stdout).toContain("finance-record-transaction");
  });
});
