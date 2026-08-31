---
name: session-logs
description: "Search and aggregate your past conversation trajectories in sessions.sqlite. Use this when asked about past context not in MEMORY.md."
---

# session-logs

Search this group's canonical session trajectory with Python's standard-library `sqlite3` module.

## Storage and boundary

- Database: `/sessions/*/sessions.sqlite`
- `sessions.sqlite` is the canonical source of truth. Do not read legacy `*.jsonl` files; they may be migration leftovers or rollback backups and do not contain current SQLite-era writes.
- One database belongs to one AgentGroup; only the current group directory is mounted.
- `sessions` holds identity metadata. `session_entries` is append-only and stores one message per row.
- `session_entries.payload_json` is the original AgentMessage JSON. Internal entries such as `session-time-anchor` may be present.
- `session_entries.created_at` and session timestamps are Unix milliseconds.
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

Filter in SQL before parsing JSON so large histories are not loaded unnecessarily.

```bash
python3 - <<'PY'
import json, sqlite3
from pathlib import Path

needle = 'キーワード'  # set to '' to print all text messages
session_id = None       # set to a session id to restrict the search

for db in Path('/sessions').glob('*/sessions.sqlite'):
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    clauses, params = [], []
    if session_id:
        clauses.append('session_id = ?')
        params.append(session_id)
    if needle:
        clauses.append('payload_json LIKE ?')
        params.append(f'%{needle}%')

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ''
    sql = f'''SELECT session_id, sequence, entry_type, payload_json, created_at
              FROM session_entries {where}
              ORDER BY session_id, sequence'''

    for sid, sequence, entry_type, payload, created_at in con.execute(sql, params):
        message = json.loads(payload)
        content = message.get('content', '')
        if isinstance(content, list):
            texts = [b.get('text', '') for b in content
                     if isinstance(b, dict) and b.get('type') == 'text']
            text = '\n'.join(filter(None, texts))
        else:
            text = str(content)
        if needle and needle.lower() not in text.lower():
            continue
        print(f'{db.parent.name}/{sid}#{sequence}\t{entry_type}\t{created_at}\t{text}')
    con.close()
PY
```

For time ranges, convert the requested boundaries to Unix milliseconds and constrain `created_at` in SQL. Narrow by `session_id`, `entry_type`, and `created_at` before loading large payload sets. Summarize results; do not paste large raw histories.
