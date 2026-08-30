/** Return a compact, mention-safe preview suitable for Discord progress events. */
export function sanitizeSubagentPreview(
  value: string,
  maxLength: number,
): string {
  const normalized = value
    .replace(/\r\n?|\n/g, " ")
    .replace(/@/g, "＠")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function taskPreview(task: string): string {
  return sanitizeSubagentPreview(task, 120) || "(empty task)";
}

export function resultPreview(result: string): string {
  return sanitizeSubagentPreview(result, 200) || "(empty result)";
}
