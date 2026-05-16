import { exec } from "node:child_process";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const TIMEOUT_MS = 30_000;

function execAsync(
  command: string,
  options: { timeout: number; maxBuffer: number; cwd: string },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, options, (err, stdout, stderr) => {
      if (err) {
        Object.assign(err, { stdout, stderr });
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

const parameters = Type.Object({
  command: Type.String({ description: "実行するシェルコマンド" }),
});

export const bashTool: AgentTool<typeof parameters> = {
  name: "bash",
  label: "Bash",
  description:
    "シェルコマンドを実行する。curl・yt-dlp・gh 等の CLI ツールも使用可",
  parameters,
  execute: async (_toolCallId, { command }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        cwd: "/workspace",
      });
      const text = [stdout, stderr ? `stderr:\n${stderr}` : ""]
        .filter(Boolean)
        .join("\n")
        .trim();
      return {
        content: [{ type: "text", text: text || "(出力なし)" }],
        details: { command },
      };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const output = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
      throw new Error(output || e.message || "コマンド実行エラー");
    }
  },
};
