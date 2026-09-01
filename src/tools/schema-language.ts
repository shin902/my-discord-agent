import type { AgentTool } from "@earendil-works/pi-agent-core";

type ToolSchemaDescriptions = {
  description: string;
  parameters?: Readonly<Record<string, string>>;
};

const ENGLISH_TOOL_SCHEMAS: Readonly<Record<string, ToolSchemaDescriptions>> = {
  bash: {
    description:
      "Run a shell command with a 30-second timeout and a 1 MB output limit. Redirect commands with large output to a file and use read to inspect only the needed parts. Prefer a dedicated tool such as agent-reach when fetching content from URLs.",
    parameters: {
      command: "Shell command to execute.",
    },
  },
  date: {
    description:
      "Get the exact current date and time. Use this tool instead of the fixed session start time whenever a decision depends on the current time, such as today, tomorrow, now, or the current clock time.",
  },
  "agent-reach": {
    description:
      "Fetch information from YouTube, GitHub, Reddit, X, RSS, or general web pages and return it as Markdown. Always use this tool when retrieving information from URLs on those services.",
    parameters: {
      url: "URL to fetch.",
    },
  },
  "arxiv-search": {
    description:
      "Search arXiv papers with a natural-language query. Supports filtering by submission date range.",
    parameters: {
      query: "Natural-language query to search on arXiv.",
      from: "Start of the submission-date range in YYYY-MM-DD format.",
      to: "End of the submission-date range in YYYY-MM-DD format.",
      max_results: "Maximum number of results. Defaults to 10; maximum 50.",
      sort: "Sort order. Defaults to relevance.",
    },
  },
  "arxiv-survey": {
    description:
      "Survey arXiv with multiple queries combined using OR. Useful for recurring or date-bounded literature surveys.",
    parameters: {
      queries: "arXiv search queries to survey together using OR.",
      from: "Start of the submission-date range in YYYY-MM-DD format.",
      to: "End of the submission-date range in YYYY-MM-DD format.",
      max_results: "Maximum number of results. Defaults to 30; maximum 50.",
      sort: "Sort order. Defaults to submitted.",
    },
  },
  read: {
    description:
      "Read a file in the workspace or an additional mounted path. Use startLine and lineCount for a line range, lineCount alone for lines from the beginning, startLine alone for the suffix from that line, or tailCount for lines from the end. tailCount cannot be combined with startLine or lineCount. For large files, read consecutive bounded ranges instead of the whole file.",
    parameters: {
      path:
        "Path to read, relative to the workspace root or an absolute path for an additional mount such as /obsidian.",
      startLine:
        "1-based line number to start reading from, through EOF unless lineCount is also set.",
      lineCount:
        "Number of lines to return. If startLine is omitted, reading starts at the beginning.",
      tailCount:
        "Number of lines to return from the end. Cannot be combined with startLine or lineCount.",
    },
  },
  write: {
    description:
      "Create or overwrite a file in the workspace or an additional mounted path.",
    parameters: {
      path:
        "Path to write, relative to the workspace root or an absolute path for an additional mount such as /obsidian.",
      content: "Content to write.",
    },
  },
  list: {
    description:
      "List files and directories in the workspace or an additional mounted path.",
    parameters: {
      path:
        "Directory path to list, relative to the workspace root or an absolute path for an additional mount such as /obsidian. Use an empty string for the workspace root.",
    },
  },
  edit: {
    description: "Edit part of a file by replacing a string.",
    parameters: {
      path:
        "Path to edit, relative to the workspace root or an absolute path for an additional mount such as /obsidian.",
      oldString: "String to replace.",
      newString: "Replacement string.",
    },
  },
  glob: {
    description: "Find files using a glob pattern.",
    parameters: {
      pattern: "Glob pattern, for example **/*.ts.",
      path:
        "Base directory for the search, relative to the workspace root or an absolute path for an additional mount such as /obsidian. Use an empty string for the workspace root.",
    },
  },
  grep: {
    description: "Search files with a regular expression.",
    parameters: {
      pattern: "Regular expression pattern to search for.",
      path:
        "File or directory to search, relative to the workspace root or an absolute path for an additional mount such as /obsidian.",
      glob: "Optional glob pattern used to filter files, for example *.ts.",
      maxResults: "Maximum number of matches to return. Defaults to 200.",
    },
  },
  "list-emails": {
    description:
      "List Outlook emails with subject, sender, received time, and body preview.",
    parameters: {
      limit: "Number of emails to return. Defaults to 10; maximum 50.",
      folder:
        "Mail folder name such as inbox, sentitems, or drafts. Defaults to inbox.",
      unreadOnly: "When true, return only unread emails. Defaults to false.",
    },
  },
  "read-email": {
    description:
      "Read the full content of an email using an ID returned by list-emails. Marks the email as read by default.",
    parameters: {
      id: "Email ID returned by list-emails.",
      markAsRead: "Whether to mark the email as read. Defaults to true.",
    },
  },
  "list-issues": {
    description:
      "List issues in a repository, returning their number, title, state, labels, and comment count. Pull requests are excluded.",
    parameters: {
      owner: "Repository owner (user or organization name).",
      repo: "Repository name.",
      state: "Issue state to include. Defaults to open.",
      limit: "Number of issues to return. Defaults to 10; maximum 50.",
    },
  },
  "read-issue": {
    description: "Read the full body of a specified GitHub issue.",
    parameters: {
      owner: "Repository owner (user or organization name).",
      repo: "Repository name.",
      issue_number: "Issue number.",
    },
  },
  "list-issue-comments": {
    description:
      "List all comments on a GitHub issue and return the author, created time, updated time, and body as Markdown.",
    parameters: {
      owner: "Repository owner (user or organization name).",
      repo: "Repository name.",
      issue_number: "Issue number.",
    },
  },
  "list-pull-request-comments": {
    description:
      "List all conversation comments, reviews, and inline review comments on a pull request and return them as Markdown.",
    parameters: {
      owner: "Repository owner (user or organization name).",
      repo: "Repository name.",
      pull_number: "Pull request number.",
    },
  },
  "read-pull-request": {
    description:
      "Read the body and metadata of a specified GitHub pull request and return them as Markdown.",
    parameters: {
      owner: "Repository owner (user or organization name).",
      repo: "Repository name.",
      pull_number: "Pull request number.",
    },
  },
  "comment-issue": {
    description:
      "Post a comment to a specified GitHub issue. This is a public write operation, so post only to the issue explicitly requested by the user.",
    parameters: {
      owner: "Repository owner (user or organization name).",
      repo: "Repository name.",
      issue_number: "Issue number.",
      body: "Comment body in Markdown, up to 8,000 characters.",
    },
  },
  "clone-repository": {
    description:
      "Clone a GitHub repository into the agent container. The destination defaults to temporary /tmp/{repo} and, when specified, must be relative to /tmp. Omitting depth clones full history; setting depth performs a shallow clone. Credentials are injected through a proxy and are never exposed to the agent.",
    parameters: {
      owner: "Repository owner (user or organization name).",
      repo: "Repository name.",
      directory:
        "Destination directory. Defaults to /tmp/{repo}; only paths relative to /tmp are allowed.",
      depth:
        "History depth for a shallow clone. Must be a positive integer; omit it to clone full history.",
    },
  },
  "list-calendars": {
    description:
      "List Google Calendars with their ID, name, access role, and time zone.",
  },
  "list-events": {
    description:
      "List Google Calendar events with their title, start and end time, and location.",
    parameters: {
      timeMin:
        "Start of the time range in ISO 8601 format. Defaults to the current time.",
      timeMax: "End of the time range in ISO 8601 format.",
      maxResults: "Number of events to return. Defaults to 10; maximum 50.",
      calendarId:
        "Calendar ID. Defaults to primary; a shared calendar email address is also accepted.",
    },
  },
  "read-event": {
    description:
      "Read the details of a calendar event using an eventId returned by list-events.",
    parameters: {
      eventId: "Event ID returned by list-events.",
      calendarId:
        "Calendar ID. Defaults to primary; a shared calendar email address is also accepted.",
    },
  },
  "create-event": {
    description: "Create a new Google Calendar event.",
    parameters: {
      summary: "Event title.",
      start:
        "Start date/time in ISO 8601 format, or YYYY-MM-DD for an all-day event.",
      end:
        "End date/time in ISO 8601 format, or YYYY-MM-DD for an all-day event.",
      description: "Event description.",
      location: "Event location.",
      attendees: "List of attendee email addresses.",
      calendarId:
        "Calendar ID. Defaults to primary; a shared calendar email address is also accepted.",
      recurrence:
        "Recurrence content lines using only RRULE, EXRULE, RDATE, or EXDATE, for example [\"RRULE:FREQ=WEEKLY;BYDAY=MO\", \"RDATE;TZID=Asia/Tokyo:20250106T100000\"].",
      timeZone:
        "IANA time zone such as Asia/Tokyo. Required for recurring timed events, unnecessary for all-day events, and optional for ordinary one-off timed events.",
    },
  },
  "update-event": {
    description:
      "Update only the specified fields of an existing event. Changing between an all-day event and a timed event recreates the event and therefore changes its eventId. Recurrence and notification settings are retained, but conferenceData such as Google Meet is not.",
    parameters: {
      eventId: "ID of the event to update.",
      summary: "Event title.",
      start:
        "Start date/time in ISO 8601 format, or YYYY-MM-DD for an all-day event.",
      end:
        "End date/time in ISO 8601 format, or YYYY-MM-DD for an all-day event.",
      description: "Event description.",
      location: "Event location.",
      attendees: "List of attendee email addresses.",
      calendarId:
        "Calendar ID. Defaults to primary; a shared calendar email address is also accepted.",
      timeZone:
        "IANA time zone such as Asia/Tokyo. Required when recreating a timed event.",
    },
  },
  "delete-event": {
    description:
      "Delete a specified calendar event. This cannot be undone, so show the event name and time to the user and obtain final confirmation before executing it.",
    parameters: {
      eventId: "ID of the event to delete.",
      calendarId:
        "Calendar ID. Defaults to primary; a shared calendar email address is also accepted.",
    },
  },
  "browserless-smart-scrape": {
    description:
      "Scrape content from a URL with automatic fallbacks for JavaScript rendering and blocking, returning JSON. Output can reach tens of thousands of tokens, so do not use it with small-context models such as local LLMs.",
    parameters: {
      url: "URL to scrape.",
      formats:
        "Output formats such as html, markdown, screenshot, pdf, or links. Defaults to [\"markdown\"].",
    },
  },
  "browserless-search": {
    description: "Run a web search and return the results as JSON.",
    parameters: {
      query: "Search query.",
      limit: "Maximum number of results. Defaults to 3; maximum 3.",
      lang: "Language code. Defaults to ja.",
      sources:
        "Search sources such as web, news, or images. Defaults to [\"web\"].",
    },
  },
  "browserless-function": {
    description: "Run Puppeteer code in a browser and return JSON.",
    parameters: {
      code:
        "Puppeteer code to execute in the form export default async ({page}) => {...}.",
      context: "Additional context passed to the code.",
    },
  },
  "browserless-content": {
    description:
      "Fetch the full HTML after JavaScript rendering. Output can reach tens of thousands of tokens, so do not use it with small-context models such as local LLMs.",
    parameters: {
      url: "URL whose rendered HTML should be fetched.",
    },
  },
  "tavily-search": {
    description:
      "Run a web search and return results. Use it for current information and fact-checking.",
    parameters: {
      query: "Search query.",
      max_results: "Maximum number of results. Defaults to 5; maximum 10.",
      search_depth:
        "Search depth: basic is faster, advanced is more detailed but slower. Defaults to basic.",
      include_answer:
        "Whether to include an AI-generated answer summary. Defaults to true.",
      topic: "Search topic. Defaults to general.",
    },
  },
  "tavily-extract": {
    description:
      "Extract page content from specified URLs. Use it to read search-result pages in detail.",
    parameters: {
      urls: "URLs whose page content should be extracted.",
      extract_depth:
        "Extraction depth: basic is faster, advanced is more detailed but slower. Defaults to basic.",
      include_images: "Whether to include image URLs. Defaults to false.",
    },
  },
  "tavily-crawl": {
    description:
      "Crawl pages within a site starting from a specified URL and extract the content of each page.",
    parameters: {
      url: "Root URL where crawling should start.",
      max_depth: "Crawl depth from 1 to 5. Defaults to 1.",
      max_breadth:
        "Number of links to follow per page, from 1 to 500. Defaults to 20.",
      limit: "Maximum total number of pages to process. Defaults to 50.",
      instructions:
        "Natural-language instructions used to narrow the crawl target.",
      select_paths:
        "Regular expression patterns used to limit crawled URL paths.",
      extract_depth: "Extraction depth for each page. Defaults to basic.",
    },
  },
  "tavily-map": {
    description:
      "Map a site's URL structure and return the URLs without fetching page content.",
    parameters: {
      url: "Base URL where mapping should start.",
      max_depth: "Mapping depth from 1 to 5. Defaults to 1.",
      max_breadth:
        "Number of links to follow per page, from 1 to 500. Defaults to 20.",
      limit: "Maximum total number of URLs to process. Defaults to 50.",
      instructions:
        "Natural-language instructions used to narrow the mapping target. Using this option doubles the cost.",
      select_paths: "Regular expression patterns used to limit URL paths.",
      select_domains: "Regular expression patterns used to limit URL domains.",
    },
  },
  "get-current-weather": {
    description:
      "Get the current weather, temperature, humidity, and wind speed for a specified place. Use it when answering about current weather conditions.",
    parameters: {
      location:
        "Place name whose current weather should be fetched, for example Tokyo or Osaka.",
    },
  },
  "get-weather-forecast": {
    description:
      "Get a multi-day weather forecast for a specified place, including high and low temperatures and precipitation probability.",
    parameters: {
      location:
        "Place name whose weather forecast should be fetched, for example Tokyo or Osaka.",
      days: "Number of forecast days. Defaults to 3; maximum 7.",
    },
  },
};

type MutableSchema = {
  description?: string;
  properties?: Record<string, MutableSchema>;
};

/** Apply English descriptions only to fields exposed in the model-facing tool schema. */
export function applyEnglishToolSchema<T extends AgentTool>(tool: T): T {
  const english = ENGLISH_TOOL_SCHEMAS[tool.name];
  if (!english) return tool;

  (tool as { description: string }).description = english.description;
  const properties = (tool.parameters as MutableSchema).properties;
  if (!properties || !english.parameters) return tool;

  for (const [name, description] of Object.entries(english.parameters)) {
    const property = properties[name];
    if (property) property.description = description;
  }

  return tool;
}
