import type { AgentTool } from "@earendil-works/pi-agent-core";

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** Abort work, then wait for executor cleanup rather than abandoning live I/O. */
export function toolExecutionSignal(timeoutMs: number, caller?: AbortSignal) {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("Tool invocation timed out", "TimeoutError"),
      ),
    timeoutMs,
  );
  return {
    signal: caller
      ? AbortSignal.any([caller, controller.signal])
      : controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

export function wrapToolTimeout<T extends AgentTool>(
  tool: T,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
): T {
  return {
    ...tool,
    execute: async (id, args, caller, onUpdate) => {
      const execution = toolExecutionSignal(timeoutMs, caller);
      try {
        execution.signal.throwIfAborted();
        const result = await tool.execute(id, args, execution.signal, onUpdate);
        execution.signal.throwIfAborted();
        return result;
      } finally {
        execution.dispose();
      }
    },
  };
}
