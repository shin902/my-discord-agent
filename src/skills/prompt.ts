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

  return `<available_skills>\n${lines.join("\n")}\n</available_skills>\n\nIf a skill's description matches the user's request, read the SKILL.md at its location before answering and follow its instructions. Do not read skills that do not match.`;
}
