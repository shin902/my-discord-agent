---
name: session-logs
description: "Search and aggregate your past conversation trajectories in sessions.sqlite. Use this when asked about past context not in MEMORY.md."
---

# session-logs

Search this group's canonical session trajectory with Python's standard-library `sqlite3` module.

## Storage and boundary

- Database: `/sessions/*/sessions.sqlite`
- One database belongs to one AgentGroup; only the current group directory is mounted.
- `sessions` holds identity metadata. `session_entries` is append-only and stores one message per row.
- `session_entries.payload_json` is the original AgentMessage JSON. Internal entries such as `session-time-anchor` may be present.
- The fragment shown in runtime metadata (`#session=<id>`) is a logical locator, not part of the filename.

Do not edit the database. Open it read-only:

```bash
python3 - <<'PY'
import sqlite3
from pathlib import Path
for db in Path('/sessions').glob('*/sessions.sqlite'):
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    for row in con.execute('SELECT id, created_at, updated_at FROM sessions ORDER BY updated_at DESC'):
        print(db.parent.name, *row)
    con.close()
PY
```

## Extract or search messages

```bash
python3 - <<'PY'
import json, sqlite3
from pathlib import Path
needle = 'キーワード'  # set to '' to print all text messages
for db in Path('/sessions').glob('*/sessions.sqlite'):
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    sql = '''SELECT session_id, sequence, payload_json
             FROM session_entries ORDER BY session_id, sequence'''
    for session_id, sequence, payload in con.execute(sql):
        message = json.loads(payload)
        texts = [b.get('text', '') for b in message.get('content', [])
                 if isinstance(b, dict) and b.get('type') == 'text'] \
            if isinstance(message.get('content'), list) else [str(message.get('content', ''))]
        text = '\n'.join(filter(None, texts))
        if needle.lower() in text.lower():
            print(f'{db.parent.name}/{session_id}#{sequence}\t{message.get("role")}\t{text}')
    con.close()
PY
```

Narrow by `session_id`, `role`, `entry_type`, or `created_at` in SQL before loading large payload sets. Summarize results; do not paste large raw histories.
