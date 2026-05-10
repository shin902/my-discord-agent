import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

const parameters = Type.Object({
  url: Type.String({ description: "取得するURL" }),
});

export const webfetchTool: AgentTool<typeof parameters> = {
  name: "webfetch",
  label: "Web Fetch",
  description: "指定したURLのHTMLまたはテキストを取得する",
  parameters,
  execute: async (_toolCallId, { url }) => {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${url}`);
    }
    const text = await res.text();
    return {
      content: [{ type: "text", text: text.slice(0, 20000) }],
      details: { url, status: res.status },
    };
  },
};
