import { writeFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const parameters = Type.Object({
  path: Type.String({ description: "書き込むファイルのパス" }),
  content: Type.String({ description: "ファイルの内容" }),
});

export const writeTool: AgentTool<typeof parameters> = {
  name: "write",
  label: "Write File",
  description: "ファイルに内容を書き込む（既存ファイルは上書き）",
  parameters,
  execute: async (_id, { path, content }) => {
    await writeFile(path, content, "utf-8");
    return {
      content: [{ type: "text", text: `書き込み完了: ${path}` }],
      details: { path },
    };
  },
};
