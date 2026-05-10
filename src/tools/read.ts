import { readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const parameters = Type.Object({
  path: Type.String({ description: "読み込むファイルのパス" }),
});

export const readTool: AgentTool<typeof parameters> = {
  name: "read",
  label: "Read File",
  description: "ファイルの内容を読み込む",
  parameters,
  execute: async (_id, { path }) => {
    const content = await readFile(path, "utf-8");
    return {
      content: [{ type: "text", text: content }],
      details: { path },
    };
  },
};
