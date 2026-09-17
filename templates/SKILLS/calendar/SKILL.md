---
name: calendar
description: List, read, create, update, and delete Google Calendar events.
---

# Calendar

Pass the capability's JSON arguments unchanged:

```bash
bash SKILLS/calendar/scripts/calendar.sh list-events '{"maxResults":10}'
bash SKILLS/calendar/scripts/calendar.sh create-event '{"summary":"event","start":"2026-09-23T10:00:00+09:00","end":"2026-09-23T18:00:00+09:00","attendees":["user@example.com"],"timeZone":"Asia/Tokyo"}'
```

Capabilities: `list-calendars`, `list-events`, `read-event`, `create-event`, `update-event`, `delete-event`.

The script does not parse or transform arguments. Use the capability's canonical Tool schema when constructing the JSON object.
