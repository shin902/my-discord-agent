---
name: session-logs
description: "Search and aggregate your past conversation trajectories in sessions.sqlite. Use this when asked about past context not in MEMORY.md."
---

# session-logs

Search this group's canonical session trajectory with Python's standard-library `sqlite3` module.

## Storage and boundary

- Database: `/sessions/*/sessions.sqlite`
- `sessions.sqlite` is the canonical source of truth for the current session trajectory.
- One database belongs to one AgentGroup; only the current group directory is mounted.
- `sessions` holds `(agent_id, id)` identity metadata. `session_entries` stores one message per row under `(agent_id, session_id)`.
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
    for row in con.execute('SELECT agent_id, id, created_at, updated_at FROM sessions ORDER BY updated_at DESC'):
        print(db.parent.name, *row)
    con.close()
PY
```

## Extract or search messages

Use SQL to narrow on structured columns such as `agent_id`, `session_id`, `entry_type`, and `created_at`. A session ID alone does not identify an owner. Do not prefilter keyword searches with `payload_json LIKE`: JSON escaping and SQLite's ASCII-only default case folding can drop valid decoded-text matches. Decode candidate payloads first, then search the extracted text in Python.

```bash
python3 - <<'PY'
import json, sqlite3
from pathlib import Path

needle = 'キーワード'  # set to '' to print all text messages
session_id = None       # set with agent_id to restrict the search
agent_id = None         # set to 'main' or a saved Bot ID

for db in Path('/sessions').glob('*/sessions.sqlite'):
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    clauses, params = [], []
    if session_id:
        if not agent_id:
            raise ValueError('set agent_id with session_id')
        clauses.extend(('agent_id = ?', 'session_id = ?'))
        params.extend((agent_id, session_id))
    elif agent_id:
        clauses.append('agent_id = ?')
        params.append(agent_id)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ''
    sql = f'''SELECT agent_id, session_id, sequence, entry_type, payload_json, created_at
              FROM session_entries {where}
              ORDER BY agent_id, session_id, sequence'''

    folded_needle = needle.casefold()
    for owner, sid, sequence, entry_type, payload, created_at in con.execute(sql, params):
        message = json.loads(payload)
        content = message.get('content', '')
        if isinstance(content, list):
            texts = [b.get('text', '') for b in content
                     if isinstance(b, dict) and b.get('type') == 'text']
            text = '\n'.join(filter(None, texts))
        else:
            text = str(content)
        if needle and folded_needle not in text.casefold():
            continue
        print(f'{db.parent.name}/{owner}/{sid}#{sequence}\t{entry_type}\t{created_at}\t{text}')
    con.close()
PY
```

For time ranges, convert the requested boundaries to Unix milliseconds and constrain `created_at` in SQL. Narrow by `(agent_id, session_id)`, `entry_type`, and `created_at` before decoding large payload sets. Summarize results; do not paste large raw histories.
