# X saved items

`x-saved` stores saved X/Twitter posts as durable local data that agents can search and triage without receiving credentials.

The repository owns the local SQLite database at `data/x-saved/x-saved.sqlite`. Only that database is mounted into an agent sandbox:

```text
my-discord-agent
  data/x-saved/x-saved.sqlite
       |
       | configured mount
       v
agent sandbox
  /x-saved/x-saved.sqlite
  + x-saved skill
```

The repository provides the persistence layer and agent skill. The live collection source is currently unimplemented: x-saved does not depend on BirdClaw or xurl. Before live collection is rebuilt around a future Chrome Extension, another source is expected to feed the equivalent of `ingestXSavedItems`. The existing database, search, state/note management, and backups remain maintained. Source credentials and source databases must remain outside the sandbox.

## Configuration

The database and backup locations can be overridden with environment variables:

```bash
export X_SAVED_DB_PATH=/path/to/my-discord-agent/data/x-saved/x-saved.sqlite
export X_SAVED_BACKUP_DIR=/var/lib/my-discord-agent/x-saved-backups
```

The default database is `data/x-saved/x-saved.sqlite`. Backups default to `data/x-saved-backups`, outside the live database directory and therefore outside the sandbox mount. The backup directory must remain outside the live database directory.

Back up `x-saved.sqlite` and its backup files. Agent-managed status and notes cannot be reconstructed from an upstream service alone.

`config/cron.example.json` contains a disabled `x-saved-backup` handler example. When enabled, it calls the generic backup operation once per schedule, retaining 14 backups by default. Set the optional `settings.keep` value to change retention; database and backup paths continue to come from `X_SAVED_DB_PATH` and `X_SAVED_BACKUP_DIR`.

## Give an agent access

Enable the `x-saved` skill and mount only the application-owned directory:

```json
{
  "tools": ["bash"],
  "skills": ["x-saved"],
  "mounts": [
    {
      "host": "data/x-saved",
      "container": "/x-saved"
    }
  ]
}
```

The mount must be writable if the agent should use `mark` or `note`. Never mount source credentials or source databases into a sandbox.

Useful commands inside the skill:

```bash
python3 SKILLS/x-saved/scripts/x-saved.py status
python3 SKILLS/x-saved/scripts/x-saved.py pending --limit 20
python3 SKILLS/x-saved/scripts/x-saved.py recent --collection bookmarks --limit 20
python3 SKILLS/x-saved/scripts/x-saved.py search "Strix Halo"
python3 SKILLS/x-saved/scripts/x-saved.py mark <tweet-id> try
python3 SKILLS/x-saved/scripts/x-saved.py note <tweet-id> "llama.cppで試す"
```

## Daily and weekly triage

`config/cron.example.json` contains disabled examples for:

- `x-saved-daily` — process a bounded `pending` batch, inspect external links only when necessary, update state, and use `<NO_REPLY>` if nothing is worth surfacing.
- `x-saved-weekly` — resurface high-value `keep` / `try` items and stale experiments once a week.

These are normal declarative agent cron jobs. Their `mounts` field replaces inherited mounts, so include every mount the job needs.

## Data model

`seen_liked` and `seen_bookmarked` are sticky history flags. If a source no longer reports a relationship, the local record remains searchable. Agent-managed status and notes are stored in the local database and are not overwritten by ingestion.

The durable state is `data/x-saved/x-saved.sqlite`:

- `x_items` — post body, author, URL, sticky like/bookmark history, and ingest timestamps
- `x_item_state` — `inbox`, `reviewed`, `keep`, `try`, `done`, or `ignore`, plus an optional note and update time
- `x_sync_runs` — optional source health records, timestamps, errors, and new-item count
- `x_meta` — metadata such as the one-time `initial_import_completed_at` marker

The store preserves its schema migrations and merge/upsert behavior for existing databases. In particular, missing incoming metadata does not erase stored metadata, relationship flags remain sticky, and existing item state and notes remain unchanged.
