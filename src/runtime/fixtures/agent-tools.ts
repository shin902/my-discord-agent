import { createInterface } from "node:readline";
import { resolveTools } from "../../tools/registry.js";

// A deterministic Agent-side driver, running the same tool factories and output
// boundary as agent-runner, without an LLM or any production configuration.
const endpoint = {
  url: process.env.TOOL_PROXY_URL ?? "",
  token: process.env.TOOL_PROXY_TOKEN ?? "",
};
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const request = JSON.parse(line) as { tool: string; args: unknown };
    const [tool] = resolveTools(
      [request.tool],
      {},
      { toolProxyEndpoint: endpoint },
    );
    if (!tool) throw new Error("Unknown fixture tool");
    const result = await tool.execute("fixture-agent", request.args);
    process.stdout.write(`${JSON.stringify({ result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : "Tool failed" })}\n`,
    );
  }
}
