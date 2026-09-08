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

The host-side receiver accepts live captures from [x-saved-extension](https://github.com/shin902/x-saved-extension), converts them to `XSavedItem`, and calls `ingestXSavedItems`. It is independent of the agent Tool Proxy and does not use BirdClaw, xurl, or X APIs. Source credentials and source databases remain outside the sandbox.

## Live capture setup

Enable the receiver in `config/config.json` and restart the application:

```json
{
  "xSavedReceiver": { "enabled": true, "port": 8787 }
}
```

The receiver defaults to disabled, with port 8787. It binds only to `127.0.0.1`; the bind address cannot be configured. Invalid settings fail startup. Shutdown closes the receiver. It writes to the same `X_SAVED_DB_PATH` as the existing store.

Use [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) to expose this local service over HTTPS inside the Tailnet:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:8787
tailscale serve status
```

Set the extension's complete receiver URL to `https://<host>.<tailnet>.ts.net:8443/v1/x-saved/items` using the hostname shown by Serve, and grant the extension permission for that host. The browser device must be connected to the Tailnet and allowed to reach the service by its access policy. This MVP has no application bearer token: the Tailnet is the network boundary. Do not use Funnel, a public reverse proxy, or a public port forward.

The extension commits each new capture to its IndexedDB outbox before scheduling best-effort sync. Nearby captures are coalesced for 500 ms, then pending items are sent serially in batches of at most 50. Automatic and manual sync share one in-flight operation. A failed request keeps unacknowledged items locally; a later capture or the popup's `Sync pending items` retries them. No background retry scheduler is required. Worker suspension can delay best-effort delivery; the durable outbox remains the recovery source.

## Receiver protocol

`POST /v1/x-saved/items` accepts uncompressed `application/json` (optionally `charset=utf-8`), up to 8 MiB per body and 1–50 items:

```json
{
  "items": [{
    "tweet_id": "123",
    "text": "Saved post",
    "author": "@alice",
    "url": "https://x.com/alice/status/123",
    "created_at": "2026-01-01T00:00:00.000Z",
    "kind": "like"
  }],
  "idempotency_key": "optional-request-id"
}
```

Tweet IDs are positive decimal strings of at most 20 digits. `text` is required (empty text is valid for media-only posts), up to 100,000 characters. `url` must be an `https://x.com/<handle>/status/<tweet_id>` URL with a matching ID. `kind` is `like` or `bookmark`. `author` may be a handle with or without `@`; `created_at` is an ISO timestamp with a timezone. Omitted or empty author/timestamp metadata is preserved in existing rows. Unknown fields and invalid items reject the entire batch before database access. External URL metadata is deliberately omitted by this adapter, preserving stored values.

Only after the SQLite transaction commits does the receiver return `200` with `{"accepted":["like:123"]}`. Keys are unique `kind:tweet_id` values. Retries rely on item-level upserts, with no request ledger. Like and Bookmark captures merge into one Tweet row; existing status and notes remain intact.

Errors return JSON without `accepted`: `400` for invalid JSON/batches, `413` for oversized bodies, `415` for unsupported content type/encoding, and `500` for a failed database commit. Other paths return `404`, and other methods return `405`. Web-page origins are rejected (`403`); extension service-worker requests use Chrome host permissions and need no web-page CORS access.

To verify an installation, capture a Like and a Bookmark in Chrome and check the local database within a few seconds. For recovery, stop the receiver, capture another item, confirm the popup shows it pending, restart the receiver, and use `Sync pending items`. Confirm only acknowledged entries disappear. These browser/Tailnet checks require the installed extension and live runtime; automated HTTP/SQLite and extension tests cover the protocol separately.

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
