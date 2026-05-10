import { readFile, writeFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const parameters = Type.Object({
  path: Type.String({ description: "編集するファイルのパス" }),
  old_string: Type.String({ description: "置換前の文字列" }),
  new_string: Type.String({ description: "置換後の文字列" }),
});

export const editTool: AgentTool<typeof parameters> = {
  name: "edit",
  label: "Edit File",
  description: "ファイル内の特定の文字列を置換する",
  parameters,
  execute: async (_id, { path, old_string, new_string }) => {
    const content = await readFile(path, "utf-8");
    if (!content.includes(old_string)) {
      throw new Error(`文字列が見つかりません: ${old_string}`);
    }
    await writeFile(path, content.replace(old_string, new_string), "utf-8");
    return {
      content: [{ type: "text", text: `編集完了: ${path}` }],
      details: { path },
    };
  },
};
