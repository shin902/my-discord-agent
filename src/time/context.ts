export const AGENT_TIME_ZONE = "Asia/Tokyo";
export const AGENT_TIME_ZONE_LABEL = "JST";
export const AGENT_UTC_OFFSET = "+09:00";

function formatParts(timestamp: number): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AGENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function formatWeekday(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: AGENT_TIME_ZONE,
    weekday: "short",
  }).format(new Date(timestamp));
}

export function formatSessionTimeAnchor(timestamp: number): string {
  const parts = formatParts(timestamp);
  const weekday = formatWeekday(timestamp);
  return [
    "## Session time anchor",
    "",
    `Started: ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:00 ${AGENT_TIME_ZONE_LABEL} (${weekday})`,
  ].join("\n");
}

export function formatCurrentDateTime(timestamp: number): string {
  const parts = formatParts(timestamp);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${AGENT_UTC_OFFSET}`;
}
