import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { resolveProxyBaseUrl } from "./proxy-url.js";

const PROVIDER = "google-calendar";

type EventDateTime = { date?: string; dateTime?: string; timeZone?: string };

type CalendarEvent = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  htmlLink?: string;
  attendees?: Array<{ email?: string; responseStatus?: string }>;
};

// status を持つことで、呼び出し側がエラーメッセージの文字列形式に依存せず
// HTTPステータス（404 など）で分岐できるようにする
class CalendarApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "CalendarApiError";
    this.status = status;
  }
}

async function calendarFetch(path: string): Promise<unknown> {
  const baseUrl = resolveProxyBaseUrl(PROVIDER);
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CalendarApiError(
      res.status,
      `Google Calendar API エラー ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return res.json();
}

async function calendarRequest(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const baseUrl = resolveProxyBaseUrl(PROVIDER);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new CalendarApiError(
      res.status,
      `Google Calendar API ${method} エラー ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  if (res.status === 204) return null;
  return res.json();
}

// "YYYY-MM-DD" 形式は終日イベントの date として扱い、それ以外は dateTime として扱う
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function toEventDateTime(value: string): EventDateTime {
  return DATE_ONLY.test(value) ? { date: value } : { dateTime: value };
}

function formatDateTime(dt: EventDateTime | undefined): string {
  if (!dt) return "(不明)";
  return dt.date ?? dt.dateTime ?? "(不明)";
}

const calendarIdParameter = Type.Optional(
  Type.String({
    description:
      "カレンダーID（デフォルト: primary。共有カレンダーのメールアドレスも指定可）",
  }),
);

const listEventsParameters = Type.Object({
  timeMin: Type.Optional(
    Type.String({
      description: "取得範囲の開始（ISO 8601、省略時は現在時刻）",
    }),
  ),
  timeMax: Type.Optional(
    Type.String({ description: "取得範囲の終了（ISO 8601）" }),
  ),
  maxResults: Type.Optional(
    Type.Integer({
      description: "取得件数（デフォルト: 10、最大: 50）",
      minimum: 1,
      maximum: 50,
    }),
  ),
  calendarId: calendarIdParameter,
});

export const listEventsTool: AgentTool<typeof listEventsParameters> = {
  name: "list_events",
  label: "List Calendar Events",
  description:
    "Google カレンダーの予定一覧を取得する。タイトル・開始/終了時刻・場所を返す",
  parameters: listEventsParameters,
  execute: async (
    _toolCallId,
    { timeMin, timeMax, maxResults = 10, calendarId = "primary" },
  ) => {
    const params = new URLSearchParams({
      maxResults: String(Math.min(maxResults, 50)),
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: timeMin ?? new Date().toISOString(),
    });
    if (timeMax) params.set("timeMax", timeMax);

    const data = (await calendarFetch(
      `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    )) as { items: CalendarEvent[] };

    const lines: string[] = [`## 予定一覧（${calendarId}）`, ""];
    for (const event of data.items) {
      lines.push(`### ${event.summary ?? "(タイトルなし)"}`);
      lines.push(`- ID: \`${event.id}\``);
      lines.push(`- 開始: ${formatDateTime(event.start)}`);
      lines.push(`- 終了: ${formatDateTime(event.end)}`);
      if (event.location) lines.push(`- 場所: ${event.location}`);
      lines.push("");
    }
    if (data.items.length === 0) lines.push("(予定はありません)");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { calendarId, count: data.items.length },
    };
  },
};

const readEventParameters = Type.Object({
  eventId: Type.String({ description: "予定ID（list_events で取得した id）" }),
  calendarId: calendarIdParameter,
});

export const readEventTool: AgentTool<typeof readEventParameters> = {
  name: "read_event",
  label: "Read Calendar Event",
  description:
    "指定した予定の詳細を取得する。list_events で得た eventId を渡す",
  parameters: readEventParameters,
  execute: async (_toolCallId, { eventId, calendarId = "primary" }) => {
    const event = (await calendarFetch(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    )) as CalendarEvent;

    const attendees =
      event.attendees && event.attendees.length > 0
        ? event.attendees
            .map((a) => `${a.email ?? "不明"}（${a.responseStatus ?? "不明"}）`)
            .join(", ")
        : "(なし)";

    const lines = [
      `# ${event.summary ?? "(タイトルなし)"}`,
      "",
      `**開始**: ${formatDateTime(event.start)}`,
      `**終了**: ${formatDateTime(event.end)}`,
      `**場所**: ${event.location ?? "(なし)"}`,
      `**参加者**: ${attendees}`,
      "",
      "---",
      "",
      event.description ?? "",
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { eventId, calendarId },
    };
  },
};

const createEventParameters = Type.Object({
  summary: Type.String({ description: "予定のタイトル" }),
  start: Type.String({
    description:
      "開始日時（ISO 8601、例: 2025-01-01T10:00:00+09:00）。終日予定の場合は YYYY-MM-DD",
  }),
  end: Type.String({
    description:
      "終了日時（ISO 8601、例: 2025-01-01T11:00:00+09:00）。終日予定の場合は YYYY-MM-DD",
  }),
  description: Type.Optional(Type.String({ description: "予定の説明" })),
  location: Type.Optional(Type.String({ description: "場所" })),
  attendees: Type.Optional(
    Type.Array(Type.String(), { description: "参加者のメールアドレス一覧" }),
  ),
  calendarId: calendarIdParameter,
});

export const createEventTool: AgentTool<typeof createEventParameters> = {
  name: "create_event",
  label: "Create Calendar Event",
  description: "Google カレンダーに新しい予定を作成する",
  parameters: createEventParameters,
  execute: async (
    _toolCallId,
    {
      summary,
      start,
      end,
      description,
      location,
      attendees,
      calendarId = "primary",
    },
  ) => {
    const body: Record<string, unknown> = {
      summary,
      start: toEventDateTime(start),
      end: toEventDateTime(end),
    };
    if (description) body.description = description;
    if (location) body.location = location;
    if (attendees && attendees.length > 0) {
      body.attendees = attendees.map((email) => ({ email }));
    }

    const event = (await calendarRequest(
      "POST",
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      body,
    )) as CalendarEvent;

    return {
      content: [
        {
          type: "text",
          text: `予定を作成しました: ${event.summary ?? summary}\n- ID: \`${event.id}\`\n- リンク: ${event.htmlLink ?? "(なし)"}`,
        },
      ],
      details: { eventId: event.id, calendarId },
    };
  },
};

const updateEventParameters = Type.Object({
  eventId: Type.String({ description: "更新する予定のID" }),
  summary: Type.Optional(Type.String({ description: "予定のタイトル" })),
  start: Type.Optional(
    Type.String({ description: "開始日時（ISO 8601 または YYYY-MM-DD）" }),
  ),
  end: Type.Optional(
    Type.String({ description: "終了日時（ISO 8601 または YYYY-MM-DD）" }),
  ),
  description: Type.Optional(Type.String({ description: "予定の説明" })),
  location: Type.Optional(Type.String({ description: "場所" })),
  attendees: Type.Optional(
    Type.Array(Type.String(), { description: "参加者のメールアドレス一覧" }),
  ),
  calendarId: calendarIdParameter,
});

// issue #125 の再現時に Google Calendar API が実際に返したエラー文言は
// `{"error":{"errors":[{"reason":"invalid","message":"Invalid start time."}],"message":"Invalid start time."}}`。
// この文字列マッチだけでは型変更以外の原因（日時フォーマット誤り等）と区別できないため、
// マッチした場合でも実際に GET した現在値と比較し、型が変わるリクエストかどうかを再確認してから再作成する。
const INVALID_TIME_ERROR = /Invalid (start|end) time/i;

// 再作成時に元イベントから引き継がない項目。id/etag 等はサーバー管理のフィールドなので POST に含めない。
// start/end/summary/description/location/attendees は個別に上書き値を計算するため除外。
// conferenceData は conferenceDataVersion クエリパラメータが必要なため引き継がない（Meet リンクは再作成後に再設定が必要）。
const EXCLUDED_RECREATE_FIELDS = new Set([
  "id",
  "etag",
  "kind",
  "htmlLink",
  "created",
  "updated",
  "iCalUID",
  "sequence",
  "status",
  "organizer",
  "creator",
  "hangoutLink",
  "conferenceData",
  // 繰り返しイベントの単一インスタンスが持つ読み取り専用フィールド。
  // POST(再作成)に含めると親シリーズとの紐付けが破損する/エラーになるため除外する。
  "recurringEventId",
  "originalStartTime",
  "start",
  "end",
  "summary",
  "description",
  "location",
  "attendees",
]);

function isDateOnly(dt: EventDateTime | undefined): boolean {
  return dt?.date !== undefined;
}

// PATCH が終日↔時刻指定の型変更で失敗した際に、予定を削除・再作成して反映するフォールバック。
// POST(再作成)を先に行い、DELETE(旧予定削除)を後に行うことで POST 失敗時の予定消失を防ぐ。
// さらに DELETE 直前に旧予定の etag を再確認し、再作成の間に別プロセスから旧予定が更新されていた
// 場合は削除を見送って両方残し、エージェントに重複の可能性を伝える。
async function recreateEventForTypeChange(params: {
  eventId: string;
  calendarId: string;
  current: CalendarEvent & Record<string, unknown>;
  finalStart: EventDateTime | undefined;
  finalEnd: EventDateTime | undefined;
  summary?: string;
  description?: string;
  location?: string;
  attendees?: string[];
}) {
  const {
    eventId,
    calendarId,
    current,
    finalStart,
    finalEnd,
    summary,
    description,
    location,
    attendees,
  } = params;

  const recreateBody: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!EXCLUDED_RECREATE_FIELDS.has(key) && value !== undefined) {
      recreateBody[key] = value;
    }
  }
  recreateBody.summary = summary ?? current.summary;
  recreateBody.start = finalStart;
  recreateBody.end = finalEnd;
  const finalDescription = description ?? current.description;
  if (finalDescription !== undefined)
    recreateBody.description = finalDescription;
  const finalLocation = location ?? current.location;
  if (finalLocation !== undefined) recreateBody.location = finalLocation;
  const finalAttendees =
    attendees !== undefined
      ? attendees.map((email) => ({ email }))
      : current.attendees
          ?.filter((a): a is { email: string } => a.email != null)
          .map((a) => ({ email: a.email }));
  if (finalAttendees !== undefined) recreateBody.attendees = finalAttendees;

  const recreated = (await calendarRequest(
    "POST",
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    recreateBody,
  )) as CalendarEvent;

  const buildKeepBothNotice = (reason: string) => ({
    content: [
      {
        type: "text" as const,
        text: `終日↔時刻指定の変更のため新しい予定を作成しましたが、旧予定は削除しませんでした（${reason}）。重複している可能性があるため旧予定をご確認ください。\n- 新しいID: \`${recreated.id}\`\n- 旧ID: \`${eventId}\``,
      },
    ],
    details: {
      eventId: recreated.id,
      calendarId,
      recreatedFrom: eventId,
      oldEventDeleted: false,
    },
  });

  // current.etag が undefined のとき（API が etag を返さない場合）は同時編集の検知ができず、
  // 確認せずに削除へ進む。Google Calendar API は通常 etag を返すため、現状この縮退の実害は小さい想定。
  let oldEventAlreadyGone = false;
  try {
    const latest = (await calendarFetch(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    )) as Record<string, unknown>;
    if (current.etag !== undefined && latest.etag !== current.etag) {
      return buildKeepBothNotice(
        "再作成中に旧予定が別の操作で更新されたのを検知したため",
      );
    }
  } catch (checkErr) {
    if (checkErr instanceof CalendarApiError && checkErr.status === 404) {
      oldEventAlreadyGone = true;
    } else {
      const checkMessage =
        checkErr instanceof Error ? checkErr.message : String(checkErr);
      return buildKeepBothNotice(
        `旧予定の状態確認に失敗しました（${checkMessage}）`,
      );
    }
  }

  if (!oldEventAlreadyGone) {
    try {
      await calendarRequest(
        "DELETE",
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      );
    } catch (deleteErr) {
      const deleteMessage =
        deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
      return buildKeepBothNotice(
        `削除リクエストが失敗しました（${deleteMessage}）`,
      );
    }
  }

  const attendeeNotice = finalAttendees?.length
    ? "\n（参加者への招待が再送される可能性があります）"
    : "";

  return {
    content: [
      {
        type: "text" as const,
        text: `終日↔時刻指定の変更だったため予定を再作成しました: ${recreated.summary ?? "(タイトルなし)"}\n- 新しいID: \`${recreated.id}\`（旧ID: \`${eventId}\` は削除済み）${attendeeNotice}`,
      },
    ],
    details: { eventId: recreated.id, calendarId, recreatedFrom: eventId },
  };
}

export const updateEventTool: AgentTool<typeof updateEventParameters> = {
  name: "update_event",
  label: "Update Calendar Event",
  description:
    "既存の予定を更新する。指定したフィールドのみ変更し、他は維持する。終日↔時刻指定の変更時は予定を削除・再作成するため eventId が変わる（繰り返し設定・通知設定は引き継ぐが、Google Meet 等の conferenceData は引き継がれない）",
  parameters: updateEventParameters,
  execute: async (
    _toolCallId,
    {
      eventId,
      summary,
      start,
      end,
      description,
      location,
      attendees,
      calendarId = "primary",
    },
  ) => {
    const body: Record<string, unknown> = {};
    if (summary !== undefined) body.summary = summary;
    if (start !== undefined) body.start = toEventDateTime(start);
    if (end !== undefined) body.end = toEventDateTime(end);
    if (description !== undefined) body.description = description;
    if (location !== undefined) body.location = location;
    if (attendees !== undefined) {
      body.attendees = attendees.map((email) => ({ email }));
    }

    try {
      const event = (await calendarRequest(
        "PATCH",
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
        body,
      )) as CalendarEvent;

      return {
        content: [
          {
            type: "text",
            text: `予定を更新しました: ${event.summary ?? "(タイトルなし)"}\n- ID: \`${event.id}\``,
          },
        ],
        details: { eventId, calendarId },
      };
    } catch (err) {
      // Google Calendar API は終日イベント↔時刻指定イベント間の型変更を PATCH では受け付けないため、
      // 削除して同内容を再作成するフォールバックを行う
      const message = err instanceof Error ? err.message : String(err);
      if (
        !INVALID_TIME_ERROR.test(message) ||
        (start === undefined && end === undefined)
      ) {
        throw err;
      }

      // GET と再作成(POST)の間に旧イベントが更新される可能性は残るが、再作成内容のスナップショットは
      // ここで取得するしかなく、削除直前の etag 再確認（recreateEventForTypeChange 内）でしか検知できない。
      const current = (await calendarFetch(
        `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      )) as CalendarEvent & Record<string, unknown>;

      // エラー文言だけでは「本当に終日↔時刻指定の変更が原因か」を判別できないため、
      // 取得した現在値と比較し、実際に型が変わるリクエストでない場合は元のエラーを伝える。
      // （型変更でないのに再作成してしまうと、別原因のエラーで POST だけ通った場合に
      // 正しい元イベントを誤って削除してしまう恐れがあるため）
      const startTypeChanges =
        start !== undefined &&
        isDateOnly(toEventDateTime(start)) !== isDateOnly(current.start);
      const endTypeChanges =
        end !== undefined &&
        isDateOnly(toEventDateTime(end)) !== isDateOnly(current.end);
      if (!startTypeChanges && !endTypeChanges) {
        throw err;
      }

      const finalStart =
        start !== undefined ? toEventDateTime(start) : current.start;
      const finalEnd = end !== undefined ? toEventDateTime(end) : current.end;
      if (isDateOnly(finalStart) !== isDateOnly(finalEnd)) {
        throw new Error(
          "終日↔時刻指定の変更には start と end を両方指定してください（片方だけ変更すると型が混在しエラーになります）",
        );
      }

      return recreateEventForTypeChange({
        eventId,
        calendarId,
        current,
        finalStart,
        finalEnd,
        summary,
        description,
        location,
        attendees,
      });
    }
  },
};

const deleteEventParameters = Type.Object({
  eventId: Type.String({ description: "削除する予定のID" }),
  calendarId: calendarIdParameter,
});

export const deleteEventTool: AgentTool<typeof deleteEventParameters> = {
  name: "delete_event",
  label: "Delete Calendar Event",
  description: "指定した予定を削除する",
  parameters: deleteEventParameters,
  execute: async (_toolCallId, { eventId, calendarId = "primary" }) => {
    await calendarRequest(
      "DELETE",
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );

    return {
      content: [{ type: "text", text: `予定を削除しました: \`${eventId}\`` }],
      details: { eventId, calendarId },
    };
  },
};
