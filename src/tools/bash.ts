import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { z } from "zod";

import { execAsync } from "./exec.js";

const TIMEOUT_MS = 30_000;
type ExecAsync = typeof execAsync;

const parameters = Type.Object({
  command: Type.String({ description: "実行するシェルコマンド" }),
});

export function createBashTool(exec: ExecAsync = execAsync): AgentTool<typeof parameters> {
  return {
  name: "bash",
  label: "Bash",
  description:
    "シェルコマンドを実行する（タイムアウト30秒・出力上限1MB）。出力が大きくなるコマンドはファイルへリダイレクトし、read で必要な部分だけ読むこと。URL からのコンテンツ取得は、agent-reach 等の専用手段があればそちらを優先する",
  parameters,
  execute: async (_toolCallId, { command }) => {
    try {
      const { stdout, stderr } = await exec(command, {
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
      const parsed = z
        .object({
          stdout: z.string().optional(),
          stderr: z.string().optional(),
          message: z.string().optional(),
        })
        .safeParse(err);
      const details = parsed.success ? parsed.data : {};
      const output = [details.stdout, details.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      throw new Error(output || details.message || "コマンド実行エラー");
    }
    },
  };
}

export const bashTool = createBashTool();
