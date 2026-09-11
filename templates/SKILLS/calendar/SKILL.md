---
name: calendar
description: Read and manage Google Calendar events through the shared Tool Proxy. Use for calendar lookup, creation, updates, and deletion.
---

# Calendar

Calendar read and write operations intentionally live in one Skill. Use the single public CLI and its subcommand help:

```bash
python3 SKILLS/calendar/scripts/calendar.py --help
python3 SKILLS/calendar/scripts/calendar.py calendars
python3 SKILLS/calendar/scripts/calendar.py events --calendar-id primary --max-results 10
python3 SKILLS/calendar/scripts/calendar.py event EVENT_ID --calendar-id primary

# Create, update, and delete (confirm mutations and targets first)
python3 SKILLS/calendar/scripts/calendar.py create \
  --summary "Team sync" \
  --start 2026-09-20T10:00:00+09:00 \
  --end 2026-09-20T11:00:00+09:00 \
  --calendar-id primary --location "Tokyo" --attendee person@example.com
python3 SKILLS/calendar/scripts/calendar.py update EVENT_ID --summary "Updated title"
python3 SKILLS/calendar/scripts/calendar.py delete EVENT_ID --calendar-id primary
```

`calendar.py -h` / `--help` and every subcommand's help show the available arguments. The CLI only parses arguments and creates JSON for `tool-proxy`; OAuth credentials, validation (including event type and recurrence rules), authorization, API requests, and mutation safety remain in the existing Calendar capability and Tool Proxy. A read-only configuration should select `list-*` native tools directly rather than granting this combined Skill. Never fall back to direct Google API access.
