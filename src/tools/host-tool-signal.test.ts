import { afterEach, expect, it, vi } from "vitest";
import { getCapabilityDefinition } from "./registry.js";

vi.mock("../config/credential-proxy.js", () => ({
  loadCredentialProxy: async () =>
    ["google-calendar", "github", "graph"].map((provider) => ({
      provider,
      baseUrl: "https://api.example.com",
    })),
}));
vi.mock("../config/proxy-config.js", () => ({
  loadRequestTimeoutMs: async () => 120_000,
}));
afterEach(() => vi.unstubAllGlobals());

it.each([
  1, 2, 3, 4,
])("Calendar type-change fallback preserves abort at request %i", async (abortAt) => {
  const current = {
    id: "old",
    etag: "version",
    start: { date: "2026-01-01" },
    end: { date: "2026-01-02" },
  };
  const responses = [
    new Response("Invalid start time.", { status: 400 }),
    Response.json(current),
    Response.json({ id: "new" }),
    Response.json(current),
  ];
  let upstreamSignal: AbortSignal | undefined;
  const fetchMock = vi.fn((_url, init) => {
    if (fetchMock.mock.calls.length - 1 < abortAt)
      return Promise.resolve(responses[fetchMock.mock.calls.length - 1]);
    upstreamSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const caller = new AbortController();
  const tool = getCapabilityDefinition("update-event")?.factory();
  if (!tool) throw new Error("missing tool");
  const pending = tool
    .execute(
      "test",
      {
        eventId: "old",
        start: "2026-01-01T10:00:00Z",
        end: "2026-01-01T11:00:00Z",
      },
      caller.signal,
    )
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
  const reason = new Error("caller stopped");
  caller.abort(reason);
  expect(await pending).toBe(reason);
  expect(fetchMock).toHaveBeenCalledTimes(abortAt + 1);
});

it.each([
  [
    "comment-issue",
    { owner: "owner", repo: "repo", issue_number: 1, body: "fixture" },
    { number: 1 },
  ],
  ["read-email", { id: "email" }, { isRead: false }],
] as const)("%s forwards abort to the follow-up mutation", async (name, args, initial) => {
  let upstreamSignal: AbortSignal | undefined;
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json(initial))
    .mockImplementation((_url, init) => {
      upstreamSignal = init.signal;
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true },
        ),
      );
    });
  vi.stubGlobal("fetch", fetchMock);
  const caller = new AbortController();
  const tool = getCapabilityDefinition(name)?.factory();
  if (!tool) throw new Error("missing tool");
  const pending = tool
    .execute("test", args, caller.signal)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
  const reason = new Error("caller stopped");
  caller.abort(reason);
  expect(await pending).toBe(reason);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([
  ["list-calendars", {}],
  ["list-events", {}],
  ["read-event", { eventId: "event" }],
  [
    "create-event",
    { summary: "fixture", start: "2026-01-01", end: "2026-01-02" },
  ],
  ["update-event", { eventId: "event", summary: "updated" }],
  ["delete-event", { eventId: "event" }],
  ["list-issues", { owner: "owner", repo: "repo" }],
  ["read-issue", { owner: "owner", repo: "repo", issue_number: 1 }],
  ["list-issue-comments", { owner: "owner", repo: "repo", issue_number: 1 }],
  ["read-pull-request", { owner: "owner", repo: "repo", pull_number: 1 }],
  [
    "list-pull-request-comments",
    { owner: "owner", repo: "repo", pull_number: 1 },
  ],
  [
    "comment-issue",
    { owner: "owner", repo: "repo", issue_number: 1, body: "fixture" },
  ],
  ["list-emails", {}],
  ["read-email", { id: "email" }],
  ["get-current-weather", { location: "Tokyo" }],
  ["get-weather-forecast", { location: "Tokyo" }],
] as const)("%s forwards its caller signal to fetch", async (name, args) => {
  let upstreamSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url, init) => {
      upstreamSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true },
        );
      });
    }),
  );
  const tool = getCapabilityDefinition(name)?.factory();
  if (!tool) throw new Error("missing tool");
  const caller = new AbortController();
  const pending = tool
    .execute("test", args, caller.signal)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
  const reason = new Error("caller stopped");
  caller.abort(reason);
  expect(await pending).toBe(reason);
  expect(upstreamSignal?.aborted).toBe(true);
});
