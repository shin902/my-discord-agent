import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { loadCodexCloudConfig } from "../config/codex-cloud.js";

const execFileAsync = promisify(execFile);

export const codexCloudSubmitTool: AgentTool = {
  name: "codex-cloud-submit",
  label: "Codex Cloud Submit",
  description:
    "Submit a Codex Cloud task in an allowed environment using the host's logged-in Codex CLI. Returns CLI stdout when submission exits, without waiting for the Cloud task to finish.",
  parameters: Type.Object({
    environment: Type.String({
      minLength: 1,
      description:
        "Canonical opaque Codex Cloud environment ID, not a label (must be allowed by host config)",
    }),
    branch: Type.String({ minLength: 1, description: "Task starting branch" }),
    prompt: Type.String({
      minLength: 1,
      description: "Cloud task instructions",
    }),
  }),
  execute: async (_id, args, signal) => {
    const { environment, branch, prompt } = args as {
      environment: string;
      branch: string;
      prompt: string;
    };
    if (prompt === "-") {
      throw new Error(
        'Codex Cloud prompt must not be "-" (CLI stdin sentinel)',
      );
    }
    const { allowedEnvironments } = await loadCodexCloudConfig();
    if (!allowedEnvironments.includes(environment)) {
      throw new Error(`Codex Cloud environment is not allowed: ${environment}`);
    }
    signal?.throwIfAborted();
    try {
      const { stdout } = await execFileAsync(
        "codex",
        [
          "cloud",
          "exec",
          "--env",
          environment,
          "--branch",
          branch,
          "--",
          prompt,
        ],
        { encoding: "utf8", shell: false, signal },
      );
      return { content: [{ type: "text", text: stdout }], details: {} };
    } catch (error) {
      const failure = error as Error & {
        code?: string | number;
        stderr?: string;
      };
      const diagnostic = failure.stderr?.trim() || failure.message;
      const exit =
        typeof failure.code === "number" ? ` (exit ${failure.code})` : "";
      throw new Error(`codex cloud exec failed${exit}: ${diagnostic}`);
    }
  },
};
