import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { createBashOutputCapture } from "./bash-output.js";
import { execAsync } from "./exec.js";

const TIMEOUT_MS = 30_000;

const parameters = Type.Object({
  command: Type.String({ description: "Shell command to execute." }),
});

export const bashTool: AgentTool<typeof parameters> = {
  name: "bash",
  label: "Bash",
  description:
    "Run a shell command with a 30-second timeout. Large output is streamed to a private sandbox-local temporary file and returned with a bounded head/tail preview. Prefer a dedicated tool such as agent-reach when fetching content from URLs.",
  parameters,
  execute: async (_toolCallId, { command }, signal) => {
    const output = await createBashOutputCapture();
    let keepOutput = false;
    try {
      let executionError: unknown;
      try {
        await execAsync(command, {
          timeout: TIMEOUT_MS,
          maxBuffer: Number.POSITIVE_INFINITY,
          cwd: "/workspace",
          signal,
          processGroup: true,
          collectOutput: false,
          onStdout: output.onStdout,
          onStderr: output.onStderr,
        });
      } catch (error) {
        executionError = error;
      }

      let closeError: unknown;
      try {
        await output.finish();
      } catch (error) {
        closeError = error;
      }

      if (executionError || closeError) {
        const error = await output.error(closeError ?? executionError);
        keepOutput = output.hasOutput && !output.storageFailure;
        throw error;
      }

      const result = await output.result({ command });
      keepOutput = output.isLarge;
      return result;
    } finally {
      if (!keepOutput) await output.cleanup().catch(() => {});
    }
  },
};
