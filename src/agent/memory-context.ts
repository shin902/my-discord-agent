import type {
  AgentMessage,
  CustomMessage,
} from "@earendil-works/pi-agent-core";

export const INITIAL_MEMORY_TYPE = "initial-agent-memory";

export type InitialMemoryMessage = Omit<CustomMessage, "content"> & {
  customType: typeof INITIAL_MEMORY_TYPE;
  content: string;
  outcome: "selected" | "no-candidates" | "no-match" | "failed";
};

export function isInitialMemoryMessage(
  message: AgentMessage,
): message is InitialMemoryMessage {
  return (
    message.role === "custom" && message.customType === INITIAL_MEMORY_TYPE
  );
}

/** The group workspace already supplies the group boundary; encode the exact Bot ID. */
export function agentMemoryPath(agentId: string): string {
  // UTF-16 preserves even lone surrogates without replacement/collisions.
  return `agent-memory/owner-${Buffer.from(agentId, "utf16le").toString("base64url")}`;
}

export function agentMemoryPrompt(agentId: string): string {
  return [
    "## Agent Memory",
    `あなたの記憶の保存先は /workspace/${agentMemoryPath(agentId)}/ です。`,
    "今後の回答や作業判断に役立つ安定した事実・好み・教訓が得られたとき、または既存の記憶が古い・誤りと分かったときに、必要に応じて自分で作成・更新・整理してください。",
    "1テーマ1Markdownとし、内容が分かるファイル名（.md）を付けてください。本文の文字数を自分で数え、500文字以内にまとめてください。詳細への参照は置けますが、判断に必要な要点は本文に残してください。",
    "許可されている既存のread/write/edit等のツールだけを使ってください。権限がない場合は書き込みを行わないでください。秘密情報は保存しないでください。",
    "初回に選択された記憶は追加コンテキストです。現在の依頼と照合して利用してください。",
  ].join("\n");
}
