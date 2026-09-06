import { afterEach, describe, expect, it, vi } from "vitest";

const { cancelAgentReachRuntime, executeAgentReachRuntime } = vi.hoisted(
  () => ({
    cancelAgentReachRuntime: vi.fn(),
    executeAgentReachRuntime: vi.fn(),
  }),
);
vi.mock("../runtime/agent-reach-client.js", () => ({
  cancelAgentReachRuntime,
  executeAgentReachRuntime,
}));

import { agentReachCapabilityTool } from "./agent-reach-capability.js";

const result = { content: [{ type: "text" as const, text: "ok" }] };

function execute(signal?: AbortSignal): Promise<unknown> {
  return agentReachCapabilityTool.execute(
    "test-call",
    { url: "https://example.com" },
    signal,
  );
}

afterEach(() => {
  cancelAgentReachRuntime.mockReset();
  executeAgentReachRuntime.mockReset();
});

describe("agent-reach capability cancellation", () => {
  it("cancels one active runtime call and removes the listener after settlement", async () => {
    const controller = new AbortController();
    let resolveRuntime!: (value: typeof result) => void;
    executeAgentReachRuntime.mockImplementationOnce(
      () => new Promise((resolve) => (resolveRuntime = resolve)),
    );

    const pending = execute(controller.signal);
    controller.abort();

    expect(cancelAgentReachRuntime).toHaveBeenCalledOnce();
    const callId = cancelAgentReachRuntime.mock.calls[0]?.[0];
    expect(typeof callId).toBe("string");

    resolveRuntime(result);
    await expect(pending).resolves.toEqual(result);
    controller.abort();
    expect(cancelAgentReachRuntime).toHaveBeenCalledOnce();
  });

  it.each([
    "success",
    "failure",
  ])("removes the listener after a completed %s call", async (outcome) => {
    const controller = new AbortController();
    if (outcome === "success") {
      executeAgentReachRuntime.mockResolvedValueOnce(result);
      await expect(execute(controller.signal)).resolves.toEqual(result);
    } else {
      executeAgentReachRuntime.mockRejectedValueOnce(new Error("failed"));
      await expect(execute(controller.signal)).rejects.toThrow("failed");
    }

    controller.abort();
    expect(cancelAgentReachRuntime).not.toHaveBeenCalled();
  });

  it("handles an already-aborted signal with one bounded cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    executeAgentReachRuntime.mockRejectedValueOnce(
      Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      }),
    );

    await expect(execute(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(cancelAgentReachRuntime).toHaveBeenCalledOnce();
    controller.abort();
    expect(cancelAgentReachRuntime).toHaveBeenCalledOnce();
  });

  it("deduplicates an abort event racing with the already-aborted check", async () => {
    let listener: (() => void) | undefined;
    const signal = {
      aborted: true,
      addEventListener: (_type: string, callback: unknown) => {
        listener =
          typeof callback === "function" ? (callback as () => void) : undefined;
        listener?.();
      },
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    executeAgentReachRuntime.mockResolvedValueOnce(result);

    await expect(execute(signal)).resolves.toEqual(result);
    expect(cancelAgentReachRuntime).toHaveBeenCalledOnce();
    listener?.();
    expect(cancelAgentReachRuntime).toHaveBeenCalledOnce();
    expect(signal.removeEventListener).toHaveBeenCalledOnce();
  });
});
