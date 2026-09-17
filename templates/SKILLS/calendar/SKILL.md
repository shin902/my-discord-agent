---
name: calendar
description: List, read, create, update, and delete Google Calendar events.
---

# Calendar

Capabilities and uses:

- `list-calendars`: list calendars
- `list-events`: list calendar events
- `read-event`: read one event
- `create-event`: create an event
- `update-event`: update an event
- `delete-event`: delete an event

First retrieve only the capability you need, then follow its description (including safety requirements) and parameters when constructing raw JSON:

```bash
# Read the canonical Tool contract without executing it
bash SKILLS/calendar/scripts/calendar.sh list-events
# Execute with JSON matching that contract
bash SKILLS/calendar/scripts/calendar.sh list-events '{}'
```

The script does not parse or transform arguments. Skill selection does not grant permission: the run must allow the capability through native `tools` or trusted `toolSets` (normally `calendar`).
