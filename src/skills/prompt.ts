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

  return `<available_skills>\n${lines.join("\n")}\n</available_skills>\n\nユーザーの依頼が description に合致するスキルがある場合は、回答の前に必ず location の SKILL.md を読み込み、その手順に従うこと。合致しないスキルは読み込まない。`;
}
