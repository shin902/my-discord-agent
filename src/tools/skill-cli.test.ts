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
  await writeFile(
    join(directory, "tool-proxy"),
    "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$TOOL_CAPTURE\"\nprintf 'ok'\n",
    { mode: 0o700 },
  );
  await writeFile(
    join(directory, "finance-cli"),
    "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$TOOL_CAPTURE\"\nprintf 'ok'\n",
    { mode: 0o700 },
  );
  path = `${directory}:${process.env.PATH ?? ""}`;
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const script = (skill: string, name: string) =>
  fileURLToPath(
    new URL(`../../templates/SKILLS/${skill}/scripts/${name}`, import.meta.url),
  );

async function runShell(skill: string, name: string, args: string[]) {
  return execFileAsync("bash", [script(skill, name), ...args], {
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
  it("provides -h and --help on every domain shell script", async () => {
    const scripts = [
      ["agent-reach", "agent-reach.sh"],
      ["tavily-search", "search.sh"],
      ["github", "issues.sh"],
      ["github", "issue.sh"],
      ["github", "pull-request.sh"],
      ["github", "issue-comments.sh"],
      ["github", "pull-request-comments.sh"],
      ["github-write", "comment-issue.sh"],
      ["calendar", "calendars.sh"],
      ["calendar", "events.sh"],
      ["calendar", "event.sh"],
      ["calendar", "create.sh"],
      ["calendar", "update.sh"],
      ["calendar", "delete.sh"],
      ["mail", "emails.sh"],
      ["mail", "email.sh"],
      ["weather", "current.sh"],
      ["weather", "forecast.sh"],
      ["finance", "record-transaction.sh"],
      ["finance", "list-transactions.sh"],
      ["finance", "summary.sh"],
      ["finance", "add-subscription.sh"],
      ["finance", "update-subscription.sh"],
      ["finance", "cancel-subscription.sh"],
      ["finance", "list-subscriptions.sh"],
      ["finance", "subscription-history.sh"],
      ["last30days", "hn-search.sh"],
      ["last30days", "github-search.sh"],
      ["last30days", "reddit-search.sh"],
    ] as const;
    for (const [skill, name] of scripts) {
      for (const flag of ["-h", "--help"]) {
        const { stdout } = await runShell(skill, name, [flag]);
        expect(stdout.toLowerCase()).toContain("usage:");
      }
    }
    for (const name of ["search.py", "survey.py"]) {
      const { stdout } = await execFileAsync("python3", [
        script("arxiv", name),
        "--help",
      ]);
      expect(stdout).toContain("usage:");
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
      "github",
      "issues.sh",
      ["owner", "repo", "--state", "all", "--limit", "4"],
      "list-issues",
      { owner: "owner", repo: "repo", state: "all", limit: 4 },
    ],
    [
      "github",
      "issue.sh",
      ["owner", "repo", "7"],
      "read-issue",
      { owner: "owner", repo: "repo", issue_number: 7 },
    ],
    [
      "github",
      "pull-request.sh",
      ["owner", "repo", "8"],
      "read-pull-request",
      { owner: "owner", repo: "repo", pull_number: 8 },
    ],
    [
      "github",
      "issue-comments.sh",
      ["owner", "repo", "9"],
      "list-issue-comments",
      { owner: "owner", repo: "repo", issue_number: 9 },
    ],
    [
      "github",
      "pull-request-comments.sh",
      ["owner", "repo", "10"],
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
    ["calendar", "calendars.sh", [], "list-calendars", {}],
    [
      "calendar",
      "events.sh",
      [
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
      "event.sh",
      ["event-1", "--calendar-id", "work"],
      "read-event",
      { eventId: "event-1", calendarId: "work" },
    ],
    [
      "calendar",
      "create.sh",
      [
        "Meeting",
        "2026-09-20T10:00:00+09:00",
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
      "update.sh",
      ["event-1", "--summary", "Updated", "--attendee", "person@example.com"],
      "update-event",
      {
        eventId: "event-1",
        summary: "Updated",
        attendees: ["person@example.com"],
      },
    ],
    [
      "calendar",
      "delete.sh",
      ["event-1"],
      "delete-event",
      { eventId: "event-1" },
    ],
    [
      "mail",
      "emails.sh",
      ["--limit", "3", "--folder", "sentitems", "--unread-only"],
      "list-emails",
      { limit: 3, folder: "sentitems", unreadOnly: true },
    ],
    [
      "mail",
      "email.sh",
      ["mail-1", "--no-mark-as-read"],
      "read-email",
      { id: "mail-1", markAsRead: false },
    ],
    [
      "weather",
      "current.sh",
      ["Tokyo"],
      "get-current-weather",
      { location: "Tokyo" },
    ],
    [
      "weather",
      "forecast.sh",
      ["Tokyo", "--days", "5"],
      "get-weather-forecast",
      { location: "Tokyo", days: 5 },
    ],
  ] as const)("%s/%s only adapts arguments for the proxy", async (skill, name, args, capability, expected) => {
    await runShell(skill, name, [...args]);
    await expect(captured()).resolves.toEqual([capability, expected]);
  });

  it.each([
    [
      "record-transaction.sh",
      ["expense", "100", "--category", "food"],
      "finance-record-transaction",
      { type: "expense", amount: 100, category: "food" },
    ],
    [
      "list-transactions.sh",
      ["--from", "2026-09-01", "--type", "expense"],
      "finance-list-transactions",
      { from: "2026-09-01", type: "expense" },
    ],
    ["summary.sh", [], "finance-summary", {}],
    [
      "add-subscription.sh",
      ["Example", "980", "monthly", "2026-09-30"],
      "finance-add-subscription",
      {
        name: "Example",
        amount: 980,
        cycle: "monthly",
        nextDate: "2026-09-30",
      },
    ],
    [
      "update-subscription.sh",
      ["Example", "--amount", "1200", "--inactive"],
      "finance-update-subscription",
      { name: "Example", amount: 1200, active: false },
    ],
    [
      "cancel-subscription.sh",
      ["Example"],
      "finance-cancel-subscription",
      { name: "Example" },
    ],
    [
      "list-subscriptions.sh",
      ["--include-inactive"],
      "finance-list-subscriptions",
      { includeInactive: true },
    ],
    [
      "subscription-history.sh",
      ["Example"],
      "finance-subscription-history",
      { name: "Example" },
    ],
  ] as const)("finance %s adapts arguments without SQL or a path", async (name, args, operation, expected) => {
    await runShell("finance", name, [...args]);
    await expect(captured()).resolves.toEqual([operation, expected]);
  });
});
