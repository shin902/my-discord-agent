import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { wrapToolTimeout } from "./timeout.js";

afterEach(() => vi.useRealTimers());

it("aborts at the invocation deadline and waits for executor cleanup", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  let cleaned = false;
  const tool: AgentTool = {
    name: "fixture",
    label: "Fixture",
    description: "fixture",
    parameters: Type.Object({}),
    execute: async (_id, _args, caller) => {
      signal = caller;
      await new Promise<void>((resolve) =>
        caller?.addEventListener("abort", () => resolve(), { once: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      cleaned = true;
      return { content: [], details: {} };
    },
  };
  const pending = wrapToolTimeout(tool, 50)
    .execute("test", {})
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(50);
  expect(signal?.aborted).toBe(true);
  expect(cleaned).toBe(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(await pending).toHaveProperty("name", "TimeoutError");
  expect(cleaned).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not mutate the shared tool or start work for an already-aborted caller", async () => {
  vi.useFakeTimers();
  const execute = vi.fn().mockResolvedValue({ content: [], details: {} });
  const tool: AgentTool = {
    name: "fixture",
    label: "Fixture",
    description: "fixture",
    parameters: Type.Object({}),
    execute,
  };
  const wrapped = wrapToolTimeout(tool, 50);
  const reason = new Error("stopped");
  await expect(
    wrapped.execute("test", {}, AbortSignal.abort(reason)),
  ).rejects.toBe(reason);
  expect(execute).not.toHaveBeenCalled();
  expect(tool.execute).toBe(execute);
  await wrapped.execute("test", {});
  expect(vi.getTimerCount()).toBe(0);
});
