import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FINANCE_RUNTIME_DB_PATH } from "../tools/finance-db.js";
import { buildToolRuntimeArgs } from "./tool-runtime-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("finance Tool Runtime boundary", () => {
  it("creates and read-only mounts only the trusted group's finance database", async () => {
    const root = await mkdtemp(join(tmpdir(), "finance-runtime-"));
    roots.push(root);
    const args = await buildToolRuntimeArgs(
      { capability: "finance-list-transactions", args: {} },
      "finance-read",
      { root, groupName: "local", image: "fixture-image" },
    );

    const source = join(root, "groups", "local", "finance.db");
    await expect(stat(source)).resolves.toBeTruthy();
    expect(args).toContain(`FINANCE_DB_PATH=${FINANCE_RUNTIME_DB_PATH}`);
    expect(args).toContain(
      `type=bind,src=${source},dst=${FINANCE_RUNTIME_DB_PATH},readonly`,
    );
    expect(args.join(" ")).not.toContain("/tmp/other.db");
  });

  it("uses a read-write mount for finance mutations and rejects untrusted group names", async () => {
    const root = await mkdtemp(join(tmpdir(), "finance-runtime-"));
    roots.push(root);
    const args = await buildToolRuntimeArgs(
      { capability: "finance-record-transaction", args: {} },
      "finance-write",
      { root, groupName: "local", image: "fixture-image" },
    );
    expect(args).toContain(
      `type=bind,src=${join(root, "groups", "local", "finance.db")},dst=${FINANCE_RUNTIME_DB_PATH}`,
    );
    expect(
      args.some(
        (arg) =>
          arg.includes(FINANCE_RUNTIME_DB_PATH) && arg.endsWith(",readonly"),
      ),
    ).toBe(false);

    await expect(
      buildToolRuntimeArgs(
        { capability: "finance-summary", args: {} },
        "finance-invalid",
        { root, groupName: "../outside", image: "fixture-image" },
      ),
    ).rejects.toThrow("trusted group context");
  });
});
