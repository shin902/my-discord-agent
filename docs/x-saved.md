# X saved items (BirdClaw)

`x-saved` stores X/Twitter likes and bookmarks as durable local data that agents can search and triage without receiving X credentials.

BirdClaw runs on the host as the collection engine. `my-discord-agent` copies only the saved-post data it needs into its own `data/x-saved/x-saved.sqlite`; agent sandboxes never receive `~/.xurl`, browser cookies, or the BirdClaw database.

## Architecture

```text
X archive / X API
       |
       v
BirdClaw on host
  ~/.birdclaw/birdclaw.sqlite
       |
       | host-only ingest
       v
my-discord-agent
  data/x-saved/x-saved.sqlite
       |
       | configured mount
       v
agent sandbox
  /x-saved/x-saved.sqlite
  + x-saved skill
```

`seen_liked` and `seen_bookmarked` are sticky history flags. If a like or bookmark later disappears from X, the local record remains searchable. Agent-managed status and notes are stored only in `x-saved.sqlite` and are never overwritten by BirdClaw ingest.

## 1. Install BirdClaw and xurl on the host

Keep BirdClaw's Node 26 runtime separate from this repository's Node 22 runtime. Homebrew is the simplest option:

```bash
brew install steipete/tap/birdclaw
brew install --cask xdevplatform/tap/xurl
birdclaw --version
```

Authenticate xurl with the X developer app you intend to pay for:

```bash
xurl auth oauth2 --app my-app
xurl whoami
```

The scheduled process must run as the same OS user that owns the BirdClaw database and xurl authentication state.

Optional path overrides:

```bash
export BIRDCLAW_BIN=/opt/homebrew/bin/birdclaw
export BIRDCLAW_HOME=$HOME/.birdclaw
export BIRDCLAW_DB_PATH=$HOME/.birdclaw/birdclaw.sqlite
export X_SAVED_DB_PATH=/path/to/my-discord-agent/data/x-saved/x-saved.sqlite
export X_SAVED_BACKUP_DIR=/var/lib/my-discord-agent/x-saved-backups
```

`BIRDCLAW_DISABLE_LIVE_WRITES=1` is forced by the integration when invoking BirdClaw. Backups are kept outside the live database directory by default (`data/x-saved-backups`), so they are not included in the `data/x-saved` sandbox mount. Set `X_SAVED_BACKUP_DIR` to a host-only directory when using a different layout.

## 2. Import the historical archive once

Request an X archive manually, download the ZIP, then run:

```bash
pnpm x-saved:setup -- ~/Downloads/twitter-archive.zip
```

The setup command asks BirdClaw to import only `likes,bookmarks,profiles`, ingests the resulting local data into `x-saved.sqlite`, records the initial import completion time, and writes a SQLite backup.

Items seen at or before that completion time remain searchable but do not appear in normal `pending` triage. This prevents a multi-thousand-item archive import from flooding the daily agent queue. Items first seen after the initial import are eligible for triage.

If BirdClaw was already initialized, omit the archive path to ingest the existing BirdClaw database:

```bash
pnpm x-saved:setup
```

The initial import marker is initialized only once, so rerunning setup does not silently reclassify later live items.

## 3. Daily live sync

Enable a handler job based on the `x-saved-sync` example in `config/cron.example.json`:

```json
{
  "id": "x-saved-sync",
  "schedule": "0 4 * * *",
  "enabled": true,
  "handler": "jobs/birdclaw-sync.ts"
}
```

The handler runs bookmarks and likes independently with fixed `--mode xurl --limit 100 --max-pages 3 --early-stop --refresh` options, ingests whatever BirdClaw has locally, records the result in `x_sync_runs`, and keeps rolling SQLite backups under the host-only `data/x-saved-backups/` directory by default. The backup directory must be outside the live database directory and is never mounted into the agent sandbox.

Operational X/BirdClaw failures are logged and recorded but are not thrown into the generic once-per-minute cron retry loop. Recovery happens on the next scheduled run. The handler accepts only an optional `account` setting for selecting a BirdClaw account. Database paths and backup location come from the existing environment-variable resolvers.

## 4. Give an agent access

Enable the `x-saved` skill and mount only the my-discord-agent-owned directory:

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

Do not mount `~/.birdclaw` or `~/.xurl` into a sandbox. The mount must be writable if the agent should use `mark`, `tag`, or `note`.

Useful commands inside the skill:

```bash
python3 SKILLS/x-saved/scripts/x-saved.py status
python3 SKILLS/x-saved/scripts/x-saved.py pending --limit 20
python3 SKILLS/x-saved/scripts/x-saved.py search "Strix Halo"
python3 SKILLS/x-saved/scripts/x-saved.py mark <tweet-id> try
```

## 5. Daily and weekly triage

`config/cron.example.json` also contains disabled examples for:

- `x-saved-daily` — process a bounded `pending` batch after sync, inspect external links only when necessary, update state, and use `<NO_REPLY>` if nothing is worth surfacing.
- `x-saved-weekly` — resurface high-value `keep` / `try` items and stale experiments once a week.

These are normal declarative agent cron jobs. Their `mounts` field replaces inherited mounts, so include every mount the job needs.

## Data ownership

BirdClaw is treated as a replaceable source adapter. Only `src/integrations/x-saved/` knows its SQLite schema.

The durable user-managed state is `data/x-saved/x-saved.sqlite`:

- `x_items` — post body, author, URL, sticky like/bookmark history, and ingest timestamps
- `x_item_state` — `inbox`, `reviewed`, `keep`, `try`, `done`, or `ignore`, plus an optional note and update time
- `x_sync_runs` — sync health, timestamps, errors, and new-item count
- `x_meta` — the one-time `initial_import_completed_at` marker

`data/` is already Git-ignored. Back up `x-saved.sqlite` because its agent-managed state cannot be reconstructed from X or BirdClaw alone.
