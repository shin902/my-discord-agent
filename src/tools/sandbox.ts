import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Sandbox } from "microsandbox";
import { Type } from "typebox";

const MAX_OUTPUT_CHARS = 4000;
const EXEC_TIMEOUT_MS = 30_000;

const parameters = Type.Object({
  code: Type.String({ description: "実行するJavaScriptコード" }),
});

export const sandboxTool: AgentTool<typeof parameters> = {
  name: "sandbox",
  label: "Code Sandbox",
  description:
    "JavaScriptコードをmicroVM内で安全に実行し、標準出力・標準エラーを返す",
  parameters,
  execute: async (_toolCallId, { code }) => {
    const name = `agent-sandbox-${Date.now()}`;
    await using sandbox = await Sandbox.builder(name)
      .image("node:22-alpine")
      .cpus(1)
      .memory(512)
      .create();

    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<never>((_, reject) => {
      timerId = setTimeout(
        () => reject(new Error("実行タイムアウト (30秒)")),
        EXEC_TIMEOUT_MS,
      );
    });

    const result = await Promise.race([
      sandbox.exec("node", ["-e", code]),
      timer,
    ]).finally(() => clearTimeout(timerId));

    const stdout = result.stdout().slice(0, MAX_OUTPUT_CHARS);
    const stderr = result.stderr().slice(0, MAX_OUTPUT_CHARS);

    const output = [
      stdout && `stdout:\n${stdout}`,
      stderr && `stderr:\n${stderr}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      content: [{ type: "text", text: output || "(出力なし)" }],
      details: { exitCode: result.code },
    };
  },
};
