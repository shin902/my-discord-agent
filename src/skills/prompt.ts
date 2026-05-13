import type { Skill } from "./loader.js";

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const lines = skills.map(
    (s) =>
      `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.location)}</location>\n  </skill>`,
  );

  return `<available_skills>\n${lines.join("\n")}\n</available_skills>\n\n必要に応じて \`read\` ツールを使って SKILL.md の内容を読み取ってください。`;
}
