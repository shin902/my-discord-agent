import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROXY_CREDS = JSON.stringify([
  { provider: "google-calendar", baseUrl: "http://proxy.test/google-calendar" },
]);

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text == null) {
    throw new Error("Expected text content");
  }
  return first.text;
}

const originalEnv = process.env;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv, CREDENTIAL_PROXY_JSON: PROXY_CREDS };
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

describe("list_events", () => {
  const makeEventList = (overrides: Record<string, unknown>[] = []) => ({
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
    const { listEventsTool } = await import("./calendar.js");
    const result = await listEventsTool.execute("id", {});
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
    const { listEventsTool } = await import("./calendar.js");
    await listEventsTool.execute("id", {});
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/calendars/primary/events");
    expect(url).toContain("maxResults=10");
    expect(url).toContain("singleEvents=true");
  });

  it("maxResults=100 を上限50にクランプする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    const { listEventsTool } = await import("./calendar.js");
    await listEventsTool.execute("id", { maxResults: 100 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("maxResults=50");
  });

  it("timeMax を指定したとき URL に反映する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    const { listEventsTool } = await import("./calendar.js");
    await listEventsTool.execute("id", { timeMax: "2025-12-31T23:59:59Z" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(
      `timeMax=${encodeURIComponent("2025-12-31T23:59:59Z")}`,
    );
  });

  it("calendarId を指定したとき URL に反映する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    const { listEventsTool } = await import("./calendar.js");
    await listEventsTool.execute("id", { calendarId: "team@example.com" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(
      `/calendars/${encodeURIComponent("team@example.com")}/events`,
    );
  });

  it("予定がないとき「予定はありません」を返す", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });
    const { listEventsTool } = await import("./calendar.js");
    const result = await listEventsTool.execute("id", {});
    expect(firstText(result)).toContain("予定はありません");
  });

  it("Calendar API エラー時は例外を投げる", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    const { listEventsTool } = await import("./calendar.js");
    await expect(listEventsTool.execute("id", {})).rejects.toThrow("401");
  });

  it("google-calendar プロバイダーが CREDENTIAL_PROXY_JSON にない場合は例外", async () => {
    process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
      { provider: "openai", baseUrl: "http://proxy.test/openai" },
    ]);
    const { listEventsTool } = await import("./calendar.js");
    await expect(listEventsTool.execute("id", {})).rejects.toThrow(
      "google-calendar プロバイダーが CREDENTIAL_PROXY_JSON に見つかりません",
    );
  });
});

describe("read_event", () => {
  const makeEvent = (overrides: Record<string, unknown> = {}) => ({
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
    const { readEventTool } = await import("./calendar.js");
    await readEventTool.execute("id", { eventId: "evt-001" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/calendars/primary/events/evt-001");
  });

  it("予定のタイトル・日時・参加者・説明をフォーマットする", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeEvent() });
    const { readEventTool } = await import("./calendar.js");
    const result = await readEventTool.execute("id", { eventId: "evt-001" });
    const text = firstText(result);
    expect(text).toContain("テスト予定");
    expect(text).toContain("2025-01-01T10:00:00+09:00");
    expect(text).toContain("alice@example.com（accepted）");
    expect(text).toContain("予定の説明");
  });

  it("eventId に特殊文字が含まれても encodeURIComponent でエスケープする", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeEvent() });
    const { readEventTool } = await import("./calendar.js");
    await readEventTool.execute("id", { eventId: "AAA==" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("AAA%3D%3D");
  });
});

describe("create_event", () => {
  it("summary/start/end を Body として POST する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "evt-new",
        summary: "新規予定",
        htmlLink: "https://calendar.google.com/event?eid=abc",
      }),
    });
    const { createEventTool } = await import("./calendar.js");
    const result = await createEventTool.execute("id", {
      summary: "新規予定",
      start: "2025-01-01T10:00:00+09:00",
      end: "2025-01-01T11:00:00+09:00",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/calendars/primary/events");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
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
    const { createEventTool } = await import("./calendar.js");
    await createEventTool.execute("id", {
      summary: "終日予定",
      start: "2025-01-01",
      end: "2025-01-02",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.start).toEqual({ date: "2025-01-01" });
    expect(body.end).toEqual({ date: "2025-01-02" });
  });

  it("attendees を email 配列に変換する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "evt-new", summary: "新規予定" }),
    });
    const { createEventTool } = await import("./calendar.js");
    await createEventTool.execute("id", {
      summary: "新規予定",
      start: "2025-01-01T10:00:00+09:00",
      end: "2025-01-01T11:00:00+09:00",
      attendees: ["alice@example.com", "bob@example.com"],
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
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
    const { createEventTool } = await import("./calendar.js");
    await expect(
      createEventTool.execute("id", {
        summary: "新規予定",
        start: "2025-01-01T10:00:00+09:00",
        end: "2025-01-01T11:00:00+09:00",
      }),
    ).rejects.toThrow("400");
  });
});

describe("update_event", () => {
  it("指定したフィールドのみ PATCH Body に含める", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "evt-001", summary: "更新後タイトル" }),
    });
    const { updateEventTool } = await import("./calendar.js");
    const result = await updateEventTool.execute("id", {
      eventId: "evt-001",
      summary: "更新後タイトル",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/calendars/primary/events/evt-001");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ summary: "更新後タイトル" });
    expect(firstText(result)).toContain("更新後タイトル");
  });

  it("start/end を指定すると dateTime/date に変換される", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "evt-001", summary: "予定" }),
    });
    const { updateEventTool } = await import("./calendar.js");
    await updateEventTool.execute("id", {
      eventId: "evt-001",
      start: "2025-02-01",
      end: "2025-02-02T10:00:00+09:00",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
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
      .mockResolvedValueOnce(deleteOk); // DELETE

    const { updateEventTool } = await import("./calendar.js");
    const result = await updateEventTool.execute("id", {
      eventId: "evt-001",
      start: "2026-06-19T14:50:00+09:00",
      end: "2026-06-19T16:50:00+09:00",
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [, createInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(createInit.method).toBe("POST");
    const [, deleteInit] = fetchMock.mock.calls[3] as [string, RequestInit];
    expect(deleteInit.method).toBe("DELETE");
    const createBody = JSON.parse(createInit.body as string);
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
      .mockResolvedValueOnce(deleteOk); // DELETE

    const { updateEventTool } = await import("./calendar.js");
    await updateEventTool.execute("id", {
      eventId: "evt-001",
      start: "2026-06-19T14:50:00+09:00",
      end: "2026-06-19T16:50:00+09:00",
    });

    const [, createInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const createBody = JSON.parse(createInit.body as string);
    expect(createBody.recurrence).toEqual(["RRULE:FREQ=WEEKLY"]);
    expect(createBody.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: "popup", minutes: 10 }],
    });
    expect(createBody.colorId).toBe("5");
    expect(createBody.conferenceData).toBeUndefined();
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

    const { updateEventTool } = await import("./calendar.js");
    await expect(
      updateEventTool.execute("id", {
        eventId: "evt-001",
        start: "2026-06-19T14:50:00+09:00",
      }),
    ).rejects.toThrow("両方指定");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce(deleteFailed); // DELETE 失敗

    const { updateEventTool } = await import("./calendar.js");
    const result = await updateEventTool.execute("id", {
      eventId: "evt-001",
      start: "2026-06-19T14:50:00+09:00",
      end: "2026-06-19T16:50:00+09:00",
    });

    expect(firstText(result)).toContain("削除に失敗");
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
    const { updateEventTool } = await import("./calendar.js");
    await expect(
      updateEventTool.execute("id", {
        eventId: "evt-001",
        summary: "更新後タイトル",
      }),
    ).rejects.toThrow("400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("delete_event", () => {
  it("DELETE リクエストを送信する", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 });
    const { deleteEventTool } = await import("./calendar.js");
    const result = await deleteEventTool.execute("id", { eventId: "evt-001" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
    const { deleteEventTool } = await import("./calendar.js");
    await expect(
      deleteEventTool.execute("id", { eventId: "evt-001" }),
    ).rejects.toThrow("404");
  });
});
