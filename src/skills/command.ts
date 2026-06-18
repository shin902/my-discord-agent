const SKILL_COMMAND_RE = /^\.\/command\s+([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/;

export interface SkillCommand {
  skillName: string;
  args: string;
}

/** `./command スキル名 [追加指示]` 形式のメッセージを解析する。一致しなければ null */
export function parseSkillCommand(content: string): SkillCommand | null {
  const match = SKILL_COMMAND_RE.exec(content.trim());
  if (!match) return null;
  return { skillName: match[1], args: match[2]?.trim() ?? "" };
}

/** スキル本文をLLMへの明示的な実行指示として整形する */
export function formatSkillCommandPrompt(
  skillName: string,
  skillBody: string,
  args: string,
): string {
  return [
    `ユーザーが \`./command\` で "${skillName}" スキルの実行を明示的に指示しました。以下の指示に従って実行してください。`,
    `<skill_instructions name="${skillName}">\n${skillBody.trim()}\n</skill_instructions>`,
    args ? `ユーザーからの追加指示:\n${args}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
