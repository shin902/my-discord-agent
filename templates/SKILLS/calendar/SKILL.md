---
name: calendar
description: Read and manage Google Calendar events through the shared Tool Proxy. Use for calendar lookup, creation, updates, and deletion.
---

# Calendar

Calendar read and write operations intentionally live in one Skill. Each thin script prints the existing capability result to stdout; use `-h` or `--help` on every script for its arguments.

```bash
# Discover calendar IDs, then list/read events
bash SKILLS/calendar/scripts/calendars.sh
bash SKILLS/calendar/scripts/events.sh --calendar-id primary --max-results 10
bash SKILLS/calendar/scripts/event.sh EVENT_ID --calendar-id primary

# Create, update, and delete (confirm mutations and targets first)
bash SKILLS/calendar/scripts/create.sh "Team sync" \
  2026-09-20T10:00:00+09:00 2026-09-20T11:00:00+09:00 \
  --calendar-id primary --location "Tokyo" --attendee person@example.com
bash SKILLS/calendar/scripts/update.sh EVENT_ID --summary "Updated title"
bash SKILLS/calendar/scripts/delete.sh EVENT_ID --calendar-id primary
```

`create.sh` accepts repeatable `--attendee` and `--recurrence` options. Timed recurring events require an IANA `--time-zone`; use `YYYY-MM-DD` for an all-day event. The scripts only parse arguments and create JSON for `tool-proxy`; OAuth credentials, validation (including event type and recurrence rules), authorization, API requests, and mutation safety remain in the existing Calendar capability and Tool Proxy. A read-only configuration should select `list-*` native tools directly rather than granting this combined Skill. Never fall back to direct Google API access.
