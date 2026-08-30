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
    "現在の正確な日時を取得する。『今日』『明日』『今』『何時』など現在時刻に依存する判断では、セッション開始時刻ではなくこのツールで確認する",
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
