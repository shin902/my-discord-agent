import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createEventTool,
  deleteEventTool,
  listEventsTool,
  readEventTool,
  updateEventTool,
  withCalendarDependencies,
  type CalendarDependencies,
} from "./calendar.js";

type TextResult = { content: Array<{ type: string; text?: string }> };
type RequestAt = { url: string; init: RequestInit };
const fixtureSchema = z.object({}).passthrough();
type CalendarFixture = z.infer<typeof fixtureSchema>;
const calendarBodySchema = z.object({}).passthrough();
type CalendarBody = z.infer<typeof calendarBodySchema>;

function firstText(result: TextResult): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text == null) {
    throw new Error("Expected text content");
  }
  return first.text;
}

let fetchMock: ReturnType<typeof vi.fn<CalendarDependencies["fetch"]>>;
const dependencies = (): CalendarDependencies => ({
  fetch: fetchMock,
  resolveProxyBaseUrl: () => "http://proxy.test/google-calendar",
});
function execute<T>(operation: () => Promise<T>): Promise<T> {
  return withCalendarDependencies(dependencies(), operation);
}
function requestAt(index: number): RequestAt {
  const [url, init] = fetchMock.mock.calls[index] ?? [];
  return { url: z.string().parse(url), init: init ?? {} };
}
function bodyAt(index: number): CalendarBody {
  const body = requestAt(index).init.body;
  return calendarBodySchema.parse(JSON.parse(z.string().parse(body)));
}

beforeEach(() => {
  process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
    {
      provider: "google-calendar",
      baseUrl: "http://proxy.test/google-calendar",
    },
  ]);
  fetchMock = vi.fn<CalendarDependencies["fetch"]>();
  vi.stubGlobal("fetch", fetchMock);
});

describe("list-events", () => {
  const makeEventList = (overrides: CalendarFixture[] = []) => ({
    items: [
      {
        id: "evt-001",
        summary: "テスト予定",
        start: { dateTime: "2025-01-01T10:00:00+09:00" },
        end: { dateTime: "2025-01-01T11:00:00+09:00" },
        location: "会議室A",
        ...overrides[0],
      },
    ],
  });

  it("予定一覧を正しくフォーマットする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeEventList(),
    });
    const result = await execute(() => listEventsTool.execute("id", {}));
    const text = firstText(result);
    expect(text).toContain("テスト予定");
    expect(text).toContain("evt-001");
    expect(text).toContain("会議室A");
  });

  it("デフォルトで calendars/primary/events かつ maxResults=10 を叩く", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeEventList(),
    });
    await execute(() => listEventsTool.execute("id", {}));
    const url = requestAt(0).url;
    expect(url).toContain("/calendars/primary/events");
    expect(url).toContain("maxResults=10");
    expect(url).toContain("singleEvents=true");
  });

  it("maxResults=100 を上限50にクランプする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    await execute(() => listEventsTool.execute("id", { maxResults: 100 }));
    const url = requestAt(0).url;
    expect(url).toContain("maxResults=50");
  });

  it("timeMax を指定したとき URL に反映する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    await execute(() =>
      listEventsTool.execute("id", { timeMax: "2025-12-31T23:59:59Z" }),
    );
    const url = requestAt(0).url;
    expect(url).toContain(
      `timeMax=${encodeURIComponent("2025-12-31T23:59:59Z")}`,
    );
  });

  it("calendarId を指定したとき URL に反映する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    await execute(() =>
      listEventsTool.execute("id", { calendarId: "team@example.com" }),
    );
    const url = requestAt(0).url;
    expect(url).toContain(
      `/calendars/${encodeURIComponent("team@example.com")}/events`,
    );
  });

  it("予定がないとき「予定はありません」を返す", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    const result = await execute(() => listEventsTool.execute("id", {}));
    expect(firstText(result)).toContain("予定はありません");
  });

  it("Calendar API エラー時は例外を投げる", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    await expect(listEventsTool.execute("id", {})).rejects.toThrow("401");
  });

  it("google-calendar プロバイダーが CREDENTIAL_PROXY_JSON にない場合は例外", async () => {
    process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
      { provider: "openai", baseUrl: "http://proxy.test/openai" },
    ]);
    await expect(listEventsTool.execute("id", {})).rejects.toThrow(
      "google-calendar プロバイダーが CREDENTIAL_PROXY_JSON に見つかりません",
    );
  });
});

describe("read-event", () => {
  const makeEvent = (overrides: CalendarFixture = {}) => ({
    id: "evt-001",
    summary: "テスト予定",
    description: "予定の説明",
    location: "会議室A",
    start: { dateTime: "2025-01-01T10:00:00+09:00" },
    end: { dateTime: "2025-01-01T11:00:00+09:00" },
    attendees: [{ email: "alice@example.com", responseStatus: "accepted" }],
    ...overrides,
  });

  it("指定した eventId で Calendar API を叩く", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeEvent() });
    await execute(() => readEventTool.execute("id", { eventId: "evt-001" }));
    const url = requestAt(0).url;
    expect(url).toContain("/calendars/primary/events/evt-001");
  });

  it("予定のタイトル・日時・参加者・説明をフォーマットする", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeEvent() });
    const result = await execute(() =>
      readEventTool.execute("id", { eventId: "evt-001" }),
    );
    const text = firstText(result);
    expect(text).toContain("テスト予定");
    expect(text).toContain("2025-01-01T10:00:00+09:00");
    expect(text).toContain("alice@example.com（accepted）");
    expect(text).toContain("予定の説明");
  });

  it("eventId に特殊文字が含まれても encodeURIComponent でエスケープする", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeEvent() });
    await execute(() => readEventTool.execute("id", { eventId: "AAA==" }));
    const url = requestAt(0).url;
    expect(url).toContain("AAA%3D%3D");
  });
});

describe("create-event", () => {
  it("summary/start/end を Body として POST する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "evt-new",
        summary: "新規予定",
        htmlLink: "https://calendar.google.com/event?eid=abc",
      }),
    });
    const result = await execute(() =>
      createEventTool.execute("id", {
        summary: "新規予定",
        start: "2025-01-01T10:00:00+09:00",
        end: "2025-01-01T11:00:00+09:00",
      }),
    );
    const { url, init } = requestAt(0);
    expect(url).toContain("/calendars/primary/events");
    expect(init.method).toBe("POST");
    const body = bodyAt(0);
    expect(body.summary).toBe("新規予定");
    expect(body.start).toEqual({ dateTime: "2025-01-01T10:00:00+09:00" });
    expect(body.end).toEqual({ dateTime: "2025-01-01T11:00:00+09:00" });
    expect(firstText(result)).toContain("evt-new");
  });

  it("YYYY-MM-DD 形式は終日イベントとして date フィールドにする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "evt-allday", summary: "終日予定" }),
    });
    await execute(() =>
      createEventTool.execute("id", {
        summary: "終日予定",
        start: "2025-01-01",
        end: "2025-01-02",
      }),
    );
    const body = bodyAt(0);
    expect(body.start).toEqual({ date: "2025-01-01" });
    expect(body.end).toEqual({ date: "2025-01-02" });
  });

  it("attendees を email 配列に変換する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "evt-new", summary: "新規予定" }),
    });
    await execute(() =>
      createEventTool.execute("id", {
        summary: "新規予定",
        start: "2025-01-01T10:00:00+09:00",
        end: "2025-01-01T11:00:00+09:00",
        attendees: ["alice@example.com", "bob@example.com"],
      }),
    );
    const body = bodyAt(0);
    expect(body.attendees).toEqual([
      { email: "alice@example.com" },
      { email: "bob@example.com" },
    ]);
  });

  it("POST エラー時は例外を投げる", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });
    await expect(
      createEventTool.execute("id", {
        summary: "新規予定",
        start: "2025-01-01T10:00:00+09:00",
        end: "2025-01-01T11:00:00+09:00",
      }),
    ).rejects.toThrow("400");
  });
});

describe("update-event", () => {
  it("指定したフィールドのみ PATCH Body に含める", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "evt-001", summary: "更新後タイトル" }),
    });
    const result = await execute(() =>
      updateEventTool.execute("id", {
        eventId: "evt-001",
        summary: "更新後タイトル",
      }),
    );
    const { url, init } = requestAt(0);
    expect(url).toContain("/calendars/primary/events/evt-001");
    expect(init.method).toBe("PATCH");
    const body = bodyAt(0);
    expect(body).toEqual({ summary: "更新後タイトル" });
    expect(firstText(result)).toContain("更新後タイトル");
  });

  it("start/end を指定すると dateTime/date に変換される", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "evt-001", summary: "予定" }),
    });
    await execute(() =>
      updateEventTool.execute("id", {
        eventId: "evt-001",
        start: "2025-02-01",
        end: "2025-02-02T10:00:00+09:00",
      }),
    );
    const body = bodyAt(0);
    expect(body.start).toEqual({ date: "2025-02-01" });
    expect(body.end).toEqual({ dateTime: "2025-02-02T10:00:00+09:00" });
  });

  it("終日↔時刻指定の変更で PATCH が 400 になった場合、削除して再作成する", async () => {
    const invalidTimeError = {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: "Invalid start time." } }),
    };
    const currentEvent = {
      ok: true,
      json: async () => ({
        id: "evt-001",
        summary: "既存タイトル",
        start: { date: "2026-06-19" },
        end: { date: "2026-06-20" },
        location: "会議室B",
        attendees: [{ email: "a@example.com", responseStatus: "accepted" }],
      }),
    };
    const deleteOk = { ok: true, status: 204 };
    const created = {
      ok: true,
      json: async () => ({ id: "evt-new-001", summary: "既存タイトル" }),
    };

    fetchMock
      .mockResolvedValueOnce(invalidTimeError) // PATCH
      .mockResolvedValueOnce(currentEvent) // GET current
      .mockResolvedValueOnce(created) // POST recreate
      .mockResolvedValueOnce(currentEvent) // GET recheck (etag比較用)
      .mockResolvedValueOnce(deleteOk); // DELETE
    const result = await execute(() =>
      updateEventTool.execute("id", {
        eventId: "evt-001",
        start: "2026-06-19T14:50:00+09:00",
        end: "2026-06-19T16:50:00+09:00",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const createInit = requestAt(2).init;
    expect(createInit.method).toBe("POST");
    const deleteInit = requestAt(4).init;
    expect(deleteInit.method).toBe("DELETE");
    const createBody = bodyAt(2);
    expect(createBody).toEqual({
      summary: "既存タイトル",
      start: { dateTime: "2026-06-19T14:50:00+09:00" },
      end: { dateTime: "2026-06-19T16:50:00+09:00" },
      location: "会議室B",
      attendees: [{ email: "a@example.com" }],
    });
    expect(firstText(result)).toContain("evt-new-001");
    expect(result.details).toEqual({
      eventId: "evt-new-001",
      calendarId: "primary",
      recreatedFrom: "evt-001",
    });
  });

  it("再作成時に recurrence/reminders/colorId を引き継ぎ、conferenceData は引き継がない", async () => {
    const invalidTimeError = {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: "Invalid start time." } }),
    };
    const currentEvent = {
      ok: true,
      json: async () => ({
        id: "evt-001",
        summary: "既存タイトル",
        start: { date: "2026-06-19" },
        end: { date: "2026-06-20" },
        recurrence: ["RRULE:FREQ=WEEKLY"],
        reminders: {
          useDefault: false,
          overrides: [{ method: "popup", minutes: 10 }],
        },
        colorId: "5",
        conferenceData: { conferenceId: "abc-defg-hij" },
      }),
    };
    const created = {
      ok: true,
      json: async () => ({ id: "evt-new-001", summary: "既存タイトル" }),
    };
    const deleteOk = { ok: true, status: 204 };

    fetchMock
      .mockResolvedValueOnce(invalidTimeError) // PATCH
      .mockResolvedValueOnce(currentEvent) // GET current
      .mockResolvedValueOnce(created) // POST recreate
      .mockResolvedValueOnce(currentEvent) // GET recheck (etag比較用)
      .mockResolvedValueOnce(deleteOk); // DELETE
    await execute(() =>
      updateEventTool.execute("id", {
        eventId: "evt-001",
        start: "2026-06-19T14:50:00+09:00",
        end: "2026-06-19T16:50:00+09:00",
      }),
    );

    const createBody = bodyAt(2);
    expect(createBody.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
    expect(createBody.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: "popup", minutes: 10 }],
    });
    expect(createBody.colorId).toBe("5");
    expect(createBody.conferenceData).toBeUndefined();
  });

  it("繰り返しイベントのインスタンスを再作成する場合、recurringEventId/originalStartTime を引き継がない", async () => {
    const invalidTimeError = {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: "Invalid start time." } }),
    };
    const currentEvent = {
      ok: true,
      json: async () => ({
        id: "evt-001",
        summary: "既存タイトル",
        start: { date: "2026-06-19" },
        end: { date: "2026-06-20" },
        recurringEventId: "evt-parent-001",
        originalStartTime: { date: "2026-06-19" },
      }),
    };
    const created = {
      ok: true,
      json: async () => ({ id: "evt-new-001", summary: "既存タイトル" }),
    };
    const deleteOk = { ok: true, status: 204 };

    fetchMock
      .mockResolvedValueOnce(invalidTimeError) // PATCH
      .mockResolvedValueOnce(currentEvent) // GET current
      .mockResolvedValueOnce(created) // POST recreate
      .mockResolvedValueOnce(currentEvent) // GET recheck (etag比較用)
      .mockResolvedValueOnce(deleteOk); // DELETE
    await execute(() =>
      updateEventTool.execute("id", {
        eventId: "evt-001",
        start: "2026-06-19T14:50:00+09:00",
        end: "2026-06-19T16:50:00+09:00",
      }),
    );

    const createBody = bodyAt(2);
    expect(createBody.recurringEventId).toBeUndefined();
    expect(createBody.originalStartTime).toBeUndefined();
  });

  it("終日↔時刻指定の変更で start のみ指定し end が未指定だと型混在エラーになる", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: "Invalid start time." } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "evt-001",
        summary: "既存タイトル",
        start: { date: "2026-06-19" },
        end: { date: "2026-06-20" },
      }),
    });
    await expect(
      updateEventTool.execute("id", {
        eventId: "evt-001",
        start: "2026-06-19T14:50:00+09:00",
      }),
    ).rejects.toThrow("両方指定");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("エラー文言が一致しても実際には型が変わっていない場合は再作成せず元のエラーを投げる", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: "Invalid start time." } }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: "evt-001",
        summary: "既存タイトル",
        start: { dateTime: "2026-06-19T10:00:00+09:00" },
        end: { dateTime: "2026-06-19T11:00:00+09:00" },
      }),
    });
    await expect(
      updateEventTool.execute("id", {
        eventId: "evt-001",
        // 既存も dateTime のままなので型変更ではない（フォーマット誤り等の別原因のはず）
        start: "invalid-date-string",
        end: "2026-06-19T16:50:00+09:00",
      }),
    ).rejects.toThrow("Invalid start time");
    // GET で現在値を確認した上で再作成せず終了する（POST/DELETE は呼ばれない）
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("再作成中に旧予定が別プロセスから更新されていた場合は削除せず警告する", async () => {
    const invalidTimeError = {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: "Invalid start time." } }),
    };
    const currentEvent = {
      ok: true,
      json: async () => ({
        id: "evt-001",
        summary: "既存タイトル",
        start: { date: "2026-06-19" },
        end: { date: "2026-06-20" },
        etag: '"etag-v1"',
      }),
    };
    const created = {
      ok: true,
      json: async () => ({ id: "evt-new-001", summary: "既存タイトル" }),
    };
    const updatedByOther = {
      ok: true,
      json: async () => ({
        id: "evt-001",
        summary: "別プロセスによる変更後",
        start: { date: "2026-06-19" },
        end: { date: "2026-06-20" },
        etag: '"etag-v2"',
      }),
    };

    fetchMock
      .mockResolvedValueOnce(invalidTimeError) // PATCH
      .mockResolvedValueOnce(currentEvent) // GET current
      .mockResolvedValueOnce(created) // POST recreate
      .mockResolvedValueOnce(updatedByOther); // GET recheck: etag が変わっている
    const result = await execute(() =>
      updateEventTool.execute("id", {
        eventId: "evt-001",
        start: "2026-06-19T14:50:00+09:00",
        end: "2026-06-19T16:50:00+09:00",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(4); // DELETE は呼ばれない
    expect(firstText(result)).toContain("別の操作で更新された");
    expect(result.details).toEqual({
      eventId: "evt-new-001",
      calendarId: "primary",
      recreatedFrom: "evt-001",
      oldEventDeleted: false,
    });
  });

  it("再確認時に旧予定が既に削除済み(404)なら DELETE を呼ばずに成功扱いにする", async () => {
    const invalidTimeError = {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: "Invalid start time." } }),
    };
    const currentEvent = {
      ok: true,
      json: async () => ({
        id: "evt-001",
        summary: "既存タイトル",
        start: { date: "2026-06-19" },
        end: { date: "2026-06-20" },
      }),
    };
    const created = {
      ok: true,
      json: async () => ({ id: "evt-new-001", summary: "既存タイトル" }),
    };
    const notFound = {
      ok: false,
      status: 404,
      text: async () => "Not Found",
    };

    fetchMock
      .mockResolvedValueOnce(invalidTimeError) // PATCH
      .mockResolvedValueOnce(currentEvent) // GET current
      .mockResolvedValueOnce(created) // POST recreate
      .mockResolvedValueOnce(notFound); // GET recheck: 旧予定は既に削除済み
    const result = await execute(() =>
      updateEventTool.execute("id", {
        eventId: "evt-001",
        start: "2026-06-19T14:50:00+09:00",
        end: "2026-06-19T16:50:00+09:00",
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(4); // DELETE は呼ばれない
    expect(firstText(result)).toContain("evt-new-001");
    expect(result.details).toEqual({
      eventId: "evt-new-001",
      calendarId: "primary",
      recreatedFrom: "evt-001",
    });
  });

  it("再作成後の DELETE が失敗した場合は例外にせず、重複している旨をエージェントに伝える", async () => {
    const invalidTimeError = {
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({ error: { message: "Invalid start time." } }),
    };
    const currentEvent = {
      ok: true,
      json: async () => ({
        id: "evt-001",
        summary: "既存タイトル",
        start: { date: "2026-06-19" },
        end: { date: "2026-06-20" },
      }),
    };
    const created = {
      ok: true,
      json: async () => ({ id: "evt-new-001", summary: "既存タイトル" }),
    };
    const deleteFailed = {
      ok: false,
      status: 500,
      text: async () => "internal error",
    };

    fetchMock
      .mockResolvedValueOnce(invalidTimeError) // PATCH
      .mockResolvedValueOnce(currentEvent) // GET current
      .mockResolvedValueOnce(created) // POST recreate
      .mockResolvedValueOnce(currentEvent) // GET recheck (etag比較用)
      .mockResolvedValueOnce(deleteFailed); // DELETE 失敗
    const result = await execute(() =>
      updateEventTool.execute("id", {
        eventId: "evt-001",
        start: "2026-06-19T14:50:00+09:00",
        end: "2026-06-19T16:50:00+09:00",
      }),
    );

    expect(firstText(result)).toContain("削除リクエストが失敗しました");
    expect(firstText(result)).toContain("evt-new-001");
    expect(firstText(result)).toContain("evt-001");
    expect(result.details).toEqual({
      eventId: "evt-new-001",
      calendarId: "primary",
      recreatedFrom: "evt-001",
      oldEventDeleted: false,
    });
  });

  it("start/end 以外のエラーや start/end 未指定の 400 はそのまま投げる", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "Bad Request" } }),
    });
    await expect(
      updateEventTool.execute("id", {
        eventId: "evt-001",
        summary: "更新後タイトル",
      }),
    ).rejects.toThrow("400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("delete-event", () => {
  it("DELETE リクエストを送信する", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    const result = await execute(() =>
      deleteEventTool.execute("id", { eventId: "evt-001" }),
    );
    const { url, init } = requestAt(0);
    expect(url).toContain("/calendars/primary/events/evt-001");
    expect(init.method).toBe("DELETE");
    expect(firstText(result)).toContain("evt-001");
  });

  it("DELETE エラー時は例外を投げる", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    });
    await expect(
      deleteEventTool.execute("id", { eventId: "evt-001" }),
    ).rejects.toThrow("404");
  });
});
