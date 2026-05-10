import { lookup } from "node:dns/promises";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";

const PRIVATE_IP = [
  /^127\./,
  /^169\.254\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
];

function isPrivateAddress(ip: string): boolean {
  return PRIVATE_IP.some((r) => r.test(ip));
}

const parameters = Type.Object({
  url: Type.String({ description: "取得するURL" }),
});

export const webfetchTool: AgentTool<typeof parameters> = {
  name: "webfetch",
  label: "Web Fetch",
  description: "指定したURLのHTMLまたはテキストを取得する",
  parameters,
  execute: async (_toolCallId, { url }) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`許可されていないプロトコル: ${parsed.protocol}`);
    }
    const { address } = await lookup(parsed.hostname);
    if (isPrivateAddress(address)) {
      throw new Error(`内部アドレスへのアクセスは禁止: ${address}`);
    }
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
