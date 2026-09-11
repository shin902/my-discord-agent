import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
let directory: string;
let capturePath: string;
let path: string;

beforeAll(async () => {
  directory = await mkdtemp("/tmp/domain-skill-cli-");
  capturePath = join(directory, "capture");
  for (const command of ["tool-proxy", "finance-cli"]) {
    await writeFile(
      join(directory, command),
      "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$TOOL_CAPTURE\"\nprintf 'ok'\n",
      { mode: 0o700 },
    );
  }
  path = `${directory}:${process.env.PATH ?? ""}`;
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const script = (skill: string, name: string) =>
  fileURLToPath(
    new URL(`../../templates/SKILLS/${skill}/scripts/${name}`, import.meta.url),
  );

async function runScript(skill: string, name: string, args: string[]) {
  const command = name.endsWith(".py") ? "python3" : "bash";
  return execFileAsync(command, [script(skill, name), ...args], {
    env: { ...process.env, PATH: path, TOOL_CAPTURE: capturePath },
  });
}

async function captured(): Promise<[string, Record<string, unknown>]> {
  const lines = (await readFile(capturePath, "utf8")).trimEnd().split("\n");
  return [
    lines[0] ?? "",
    JSON.parse(lines[1] ?? "{}") as Record<string, unknown>,
  ];
}

describe("built-in domain Skill CLI frontends", () => {
  it("provides -h and --help on every public domain CLI", async () => {
    const scripts = [
      ["agent-reach", "agent-reach.sh"],
      ["tavily-search", "search.sh"],
      ["arxiv", "arxiv.py"],
      ["github", "github.py"],
      ["github-write", "comment-issue.sh"],
      ["calendar", "calendar.py"],
      ["mail", "mail.py"],
      ["weather", "weather.py"],
      ["finance", "finance.py"],
      ["last30days", "hn-search.sh"],
      ["last30days", "github-search.sh"],
      ["last30days", "reddit-search.sh"],
    ] as const;
    for (const [skill, name] of scripts) {
      for (const flag of ["-h", "--help"]) {
        const { stdout } = await runScript(skill, name, [flag]);
        expect(stdout.toLowerCase()).toContain("usage:");
      }
    }
  });

  it.each([
    [
      "tavily-search",
      "search.sh",
      [
        "query",
        "--max-results",
        "2",
        "--search-depth",
        "advanced",
        "--no-include-answer",
        "--topic",
        "news",
      ],
      "tavily-search",
      {
        query: "query",
        max_results: 2,
        search_depth: "advanced",
        include_answer: false,
        topic: "news",
      },
    ],
    [
      "arxiv",
      "arxiv.py",
      ["search", "query", "--limit", "2", "--sort", "updated"],
      "arxiv-search",
      { query: "query", max_results: 2, sort: "updated" },
    ],
    [
      "arxiv",
      "arxiv.py",
      ["survey", "first", "second", "--limit", "4"],
      "arxiv-survey",
      { queries: ["first", "second"], max_results: 4 },
    ],
    [
      "github",
      "github.py",
      ["issues", "owner", "repo", "--state", "all", "--limit", "4"],
      "list-issues",
      { owner: "owner", repo: "repo", state: "all", limit: 4 },
    ],
    [
      "github",
      "github.py",
      ["issue", "owner", "repo", "7"],
      "read-issue",
      { owner: "owner", repo: "repo", issue_number: 7 },
    ],
    [
      "github",
      "github.py",
      ["pull-request", "owner", "repo", "8"],
      "read-pull-request",
      { owner: "owner", repo: "repo", pull_number: 8 },
    ],
    [
      "github",
      "github.py",
      ["issue-comments", "owner", "repo", "9"],
      "list-issue-comments",
      { owner: "owner", repo: "repo", issue_number: 9 },
    ],
    [
      "github",
      "github.py",
      ["pull-request-comments", "owner", "repo", "10"],
      "list-pull-request-comments",
      { owner: "owner", repo: "repo", pull_number: 10 },
    ],
    [
      "github-write",
      "comment-issue.sh",
      ["owner", "repo", "11", "comment body"],
      "comment-issue",
      { owner: "owner", repo: "repo", issue_number: 11, body: "comment body" },
    ],
    ["calendar", "calendar.py", ["calendars"], "list-calendars", {}],
    [
      "calendar",
      "calendar.py",
      [
        "events",
        "--calendar-id",
        "work",
        "--time-min",
        "2026-09-01T00:00:00Z",
        "--time-max",
        "2026-09-02T00:00:00Z",
        "--max-results",
        "6",
      ],
      "list-events",
      {
        calendarId: "work",
        timeMin: "2026-09-01T00:00:00Z",
        timeMax: "2026-09-02T00:00:00Z",
        maxResults: 6,
      },
    ],
    [
      "calendar",
      "calendar.py",
      ["event", "event-1", "--calendar-id", "work"],
      "read-event",
      { eventId: "event-1", calendarId: "work" },
    ],
    [
      "calendar",
      "calendar.py",
      [
        "create",
        "--summary",
        "Meeting",
        "--start",
        "2026-09-20T10:00:00+09:00",
        "--end",
        "2026-09-20T11:00:00+09:00",
        "--location",
        "Tokyo",
        "--attendee",
        "person@example.com",
        "--recurrence",
        "RRULE:FREQ=WEEKLY",
        "--time-zone",
        "Asia/Tokyo",
      ],
      "create-event",
      {
        summary: "Meeting",
        start: "2026-09-20T10:00:00+09:00",
        end: "2026-09-20T11:00:00+09:00",
        location: "Tokyo",
        attendees: ["person@example.com"],
        recurrence: ["RRULE:FREQ=WEEKLY"],
        timeZone: "Asia/Tokyo",
      },
    ],
    [
      "calendar",
      "calendar.py",
      [
        "update",
        "event-1",
        "--summary",
        "Updated",
        "--attendee",
        "person@example.com",
      ],
      "update-event",
      {
        eventId: "event-1",
        summary: "Updated",
        attendees: ["person@example.com"],
      },
    ],
    [
      "calendar",
      "calendar.py",
      ["delete", "event-1"],
      "delete-event",
      { eventId: "event-1" },
    ],
    [
      "mail",
      "mail.py",
      ["list", "--limit", "3", "--folder", "sentitems", "--unread-only"],
      "list-emails",
      { limit: 3, folder: "sentitems", unreadOnly: true },
    ],
    [
      "mail",
      "mail.py",
      ["read", "mail-1", "--no-mark-as-read"],
      "read-email",
      { id: "mail-1", markAsRead: false },
    ],
    [
      "weather",
      "weather.py",
      ["current", "Tokyo"],
      "get-current-weather",
      { location: "Tokyo" },
    ],
    [
      "weather",
      "weather.py",
      ["forecast", "Tokyo", "--days", "5"],
      "get-weather-forecast",
      { location: "Tokyo", days: 5 },
    ],
  ] as const)("%s/%s only adapts arguments for the proxy", async (skill, name, args, capability, expected) => {
    await runScript(skill, name, [...args]);
    await expect(captured()).resolves.toEqual([capability, expected]);
  });

  it("finance.py delegates all eight operations without implementing storage", async () => {
    const cases = [
      [
        ["record-transaction", "expense", "100", "--category", "food"],
        "finance-record-transaction",
        { type: "expense", amount: 100, category: "food" },
      ],
      [
        ["list-transactions", "--from", "2026-09-01", "--type", "expense"],
        "finance-list-transactions",
        { from: "2026-09-01", type: "expense" },
      ],
      [
        ["summary", "--to", "2026-09-30"],
        "finance-summary",
        { to: "2026-09-30" },
      ],
      [
        ["add-subscription", "Example", "980", "monthly", "2026-09-30"],
        "finance-add-subscription",
        {
          name: "Example",
          amount: 980,
          cycle: "monthly",
          nextDate: "2026-09-30",
        },
      ],
      [
        ["update-subscription", "Example", "--amount", "1200", "--inactive"],
        "finance-update-subscription",
        { name: "Example", amount: 1200, active: false },
      ],
      [
        ["cancel-subscription", "Example"],
        "finance-cancel-subscription",
        { name: "Example" },
      ],
      [
        ["list-subscriptions", "--include-inactive"],
        "finance-list-subscriptions",
        { includeInactive: true },
      ],
      [
        ["subscription-history", "Example"],
        "finance-subscription-history",
        { name: "Example" },
      ],
    ] as const;
    for (const [args, operation, expected] of cases) {
      await runScript("finance", "finance.py", [...args]);
      await expect(captured()).resolves.toEqual([operation, expected]);
    }
  });

  it("keeps finance.py limited to argument adaptation", async () => {
    const source = await readFile(script("finance", "finance.py"), "utf8");
    expect(source).not.toMatch(
      /sqlite|CREATE TABLE|ALTER TABLE|recorded_at|with_database|append-only|sign conversion/iu,
    );
  });
});
