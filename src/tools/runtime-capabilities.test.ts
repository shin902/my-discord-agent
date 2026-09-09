import { describe, expect, it } from "vitest";
import { getCapabilityDefinition, resolveTools } from "./registry.js";
import {
  getRuntimeCapability,
  RUNTIME_CAPABILITIES,
} from "./runtime-capabilities.js";

const financeNames = [
  "finance-record-transaction",
  "finance-list-transactions",
  "finance-summary",
  "finance-add-subscription",
  "finance-update-subscription",
  "finance-cancel-subscription",
  "finance-list-subscriptions",
  "finance-subscription-history",
] as const;

describe("finance capability registry", () => {
  it("registers exactly eight Runtime capabilities with fixed DB access modes", () => {
    expect(
      financeNames.map((name) => getRuntimeCapability(name)?.tool),
    ).toEqual(financeNames);
    expect(
      financeNames.map((name) => getRuntimeCapability(name)?.financeDb),
    ).toEqual([
      "read-write",
      "read-only",
      "read-only",
      "read-write",
      "read-write",
      "read-write",
      "read-only",
      "read-only",
    ]);
    expect(Object.keys(RUNTIME_CAPABILITIES)).toEqual(
      expect.arrayContaining([...financeNames]),
    );
  });

  it("exposes the same Agent-facing schemas through the registry and Proxy dispatch", () => {
    for (const name of financeNames) {
      const definition = getCapabilityDefinition(name);
      expect(definition).toMatchObject({
        tool: name,
        executor: "runtime",
        factory: expect.any(Function),
        validateArgs: expect.any(Function),
        materializeArgs: expect.any(Function),
      });
      const [tool] = resolveTools(
        [name],
        {},
        {
          toolProxyEndpoint: { url: "http://proxy/rpc", token: "token" },
        },
      );
      expect(tool.name).toBe(name);
      expect(JSON.stringify(tool.parameters)).not.toContain("FINANCE_DB_PATH");
    }
  });

  it("validates transaction type and positive integer amount before Runtime dispatch", () => {
    const capability = getRuntimeCapability("finance-record-transaction");
    if (!capability) throw new Error("missing finance capability");
    expect(capability.validateArgs({ type: "income", amount: 1 })).toBe(true);
    expect(capability.validateArgs({ type: "expense", amount: 100 })).toBe(
      true,
    );
    for (const args of [
      { type: "income", amount: 0 },
      { type: "expense", amount: -1 },
      { type: "income", amount: 1.5 },
      { type: "other", amount: 1 },
    ]) {
      expect(capability.validateArgs(args)).toBe(false);
    }
    expect(
      capability.materializeArgs?.({
        type: "income",
        amount: 1,
        path: "/tmp/other.db",
      }),
    ).toEqual({ type: "income", amount: 1 });
  });
});
