import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  AGENT_TIME_ZONE,
  AGENT_TIME_ZONE_LABEL,
  AGENT_UTC_OFFSET,
  formatCurrentDateTime,
  formatWeekday,
} from "../time/context.js";

const dateParams = Type.Object({});

export const dateTool: AgentTool<typeof dateParams> = {
  name: "date",
  label: "現在日時",
  description:
    "Get the exact current date and time. Use this tool instead of the fixed session start time whenever a decision depends on the current time, such as today, tomorrow, now, or the current clock time.",
  parameters: dateParams,
  execute: async () => {
    const timestamp = Date.now();
    const localDateTime = formatCurrentDateTime(timestamp);
    const weekday = formatWeekday(timestamp);
    const utc = new Date(timestamp).toISOString();

    return {
      content: [
        {
          type: "text",
          text: [
            `Current time: ${localDateTime} (${weekday})`,
            `Timezone: ${AGENT_TIME_ZONE} (${AGENT_TIME_ZONE_LABEL}, UTC${AGENT_UTC_OFFSET})`,
            `UTC: ${utc}`,
          ].join("\n"),
        },
      ],
      details: {
        timestamp,
        localDateTime,
        timezone: AGENT_TIME_ZONE,
        timezoneLabel: AGENT_TIME_ZONE_LABEL,
        utcOffset: AGENT_UTC_OFFSET,
        utc,
      },
    };
  },
};
