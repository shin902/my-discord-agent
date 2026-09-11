#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { wrapToolInputValidation } from "../tools/capability.js";
import { createFinanceTools, FINANCE_DATABASE_PATH } from "../tools/finance.js";
import { wrapToolOutput } from "../tools/output.js";

const tools = createFinanceTools(FINANCE_DATABASE_PATH);
const operations: Record<string, AgentTool> = Object.fromEntries(
  Object.values(tools).map((tool) => [tool.name, tool]),
);

const USAGE = `Usage: finance-cli <operation> <JSON arguments>

Operations:
  finance-record-transaction
  finance-list-transactions
  finance-summary
  finance-add-subscription
  finance-update-subscription
  finance-cancel-subscription
  finance-list-subscriptions
  finance-subscription-history

The database path is fixed by the Runner image at /workspace/finance.db.`;

function textResult(result: AgentToolResult<unknown>): string {
  return result.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

export async function executeFinanceOperation(
  args: readonly string[],
  dbPath = FINANCE_DATABASE_PATH,
): Promise<string> {
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    return USAGE;
  }
  if (args.length !== 2) {
    throw new Error(USAGE);
  }

  const operation = args[0];
  const tool = operation ? operations[operation] : undefined;
  if (!tool) {
    throw new Error(`Unknown finance operation: ${operation}\n\n${USAGE}`);
  }

  let input: unknown;
  try {
    input = JSON.parse(args[1]);
  } catch {
    throw new Error("Finance CLI arguments must be valid JSON");
  }

  // Reuse the existing sandbox Tool implementation, including its schema,
  // database, and domain behavior. The database path is not agent-controlled.
  const selected =
    dbPath === FINANCE_DATABASE_PATH
      ? tool
      : Object.values(createFinanceTools(dbPath)).find(
          (candidate) => candidate.name === operation,
        );
  if (!selected) {
    throw new Error(`Unknown finance operation: ${operation}`);
  }
  const wrapped = wrapToolOutput(wrapToolInputValidation(selected));
  return textResult(await wrapped.execute("finance-cli", input as never));
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    process.stdout.write(`${await executeFinanceOperation(args)}\n`);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Finance CLI failed",
    );
    process.exitCode = 1;
  }
}

/** Detect direct execution after resolving /usr/local/bin/finance-cli symlinks. */
function isEntrypoint(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return (
      realpathSync(argvPath) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  void main();
}
