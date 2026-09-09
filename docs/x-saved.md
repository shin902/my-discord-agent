# X saved items

`x-saved` stores saved X/Twitter posts as durable local data that agents can search and triage without receiving credentials.

The repository owns the local SQLite database at `data/x-saved/x-saved.sqlite` and downloaded images under `data/x-saved/media/`. The application-owned **directory** is mounted into an agent sandbox:

```text
my-discord-agent
  data/x-saved/{x-saved.sqlite,media/}
       |
       | configured mount
       v
agent sandbox
  /x-saved/{x-saved.sqlite,media/}
  + x-saved skill + read tool
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
    "kind": "like",
    "media": [
      { "kind": "image", "position": 0, "source_url": "https://pbs.twimg.com/media/Abc?format=jpg&name=small", "alt_text": "A diagram" },
      { "kind": "video", "position": 1 }
    ]
  }],
  "idempotency_key": "optional-request-id"
}
```

Tweet IDs are positive decimal strings of at most 20 digits. `text` is required (empty text is valid for media-only posts), up to 100,000 characters. `url` must be an `https://x.com/<handle>/status/<tweet_id>` URL with a matching ID. `kind` is `like` or `bookmark`. `author` may be a handle with or without `@` and, when nonempty, must match the URL handle case-insensitively; `created_at` is an ISO timestamp with a timezone. Omitted or empty author/timestamp metadata is preserved in existing rows. Unknown fields and invalid items reject the entire batch before database access. External URL metadata is deliberately omitted by this adapter, preserving stored values. The extension applies the same item validation before IndexedDB persistence so invalid captures cannot enter the outbox and block later batches.

Optional `media` contains `image` or `video` entries in DOM order, with integer `position` 0–15 (zero-based across both kinds). At most 32 distinct `(kind, position)` entries are accepted. Images require `source_url`: HTTPS, exactly `pbs.twimg.com`, a `/media/<identifier>` path (letters/digits/underscore/hyphen, optional file extension), no credentials, non-default port or fragment, and at most 2,048 characters. Optional `alt_text` is bounded to 10,000 characters. Video entries contain only `kind` and `position`; GIFs represented by video DOM are also `video`. Unknown fields/kinds, duplicate keys, and invalid media reject the whole batch before DB access. MP4/HLS/blob URLs are not accepted.

`x_items`, `x_item_state`, and `x_media` are saved in the same transaction. Images are **not downloaded by the receiver**. Only after the SQLite transaction commits does the receiver return `200` with `{"accepted":["like:123"]}`. Keys are unique `kind:tweet_id` values. Retries rely on item-level upserts, with no request ledger. Like and Bookmark captures merge into one Tweet row; existing status and notes remain intact.

Errors return JSON without `accepted`: `400` for invalid JSON/batches, `413` for oversized bodies, `415` for unsupported content type/encoding, and `500` for a failed database commit. Other paths return `404`, and other methods return `405`. Web-page origins are rejected (`403`); extension service-worker requests use Chrome host permissions and need no web-page CORS access.

To verify an installation, capture a Like and a Bookmark in Chrome and check the local database within a few seconds. For recovery, stop the receiver, capture another item, confirm the popup shows it pending, restart the receiver, and use `Sync pending items`. Confirm only acknowledged entries disappear. These browser/Tailnet checks require the installed extension and live runtime; automated HTTP/SQLite and extension tests cover the protocol separately.

## Media backfill and image downloads

**Tweet ID is the canonical locator.** DOM media is an optional first-capture hint, not a completeness signal. Extension `sent`/`inFlight`, persistent `seen`, and outbox retain their original `kind:tweet_id` dedupe/ACK behavior: known Tweets do not re-enqueue for media enrichment. Media backfill does not require re-scrolling, re-sending, or resetting browser storage.

Enable the disabled `x-saved-media-resolve` example in `config/cron.example.json` deliberately, then restart as for other cron changes:

```json
{
  "id": "x-saved-media-resolve",
  "schedule": "*/5 * * * *",
  "enabled": true,
  "handler": "jobs/x-saved-media-resolve.ts",
  "settings": { "limit": 20 }
}
```

This deterministic host cron resolves saved Tweet IDs through the fixed public [FxTwitter API v2](https://github.com/FxEmbed/FxEmbed/blob/main/docs/specs/fxtwitter-openapi.json) endpoint `https://api.fxtwitter.com/2/status/<tweet_id>`. Neither stored URLs nor author handles are used as fetch targets. Enabling it sends Tweet IDs to FxTwitter, but no Like/Bookmark flags, text, notes, browser cookies, or credentials. Requests reject redirects and are bounded to 15 seconds / 1 MiB. Only the matching focal status's ordered `media.all` is consumed; quotes, thread posts, cards, and video source URLs are not persisted. Image URLs pass the same pbs allowlist as DOM captures. Unsupported/malformed/incomplete responses fail closed rather than marking the ID resolved.

Each run handles at most `limit` IDs (1–100, default 20), including old text-only items **and items with partial DOM metadata**. `x_media_resolution` records the last attempt and successful resolution time. Success, including an empty media result, is committed atomically with media rows. Failed IDs remain unresolved, behind unattempted/older attempts for subsequent runs; failures do not invalidate Tweet ingest or block other IDs. Deleted/private/unavailable Tweets may remain unresolved: this public service is not a credentialed completeness guarantee. There is no provider framework, retry counter/backoff/lease system, or independent timer/startup drain.

FxTwitter fills missing slots and corrects conflicting DOM image hints. Matching completed images retain their files even when size/format URLs differ; a different image in the same slot becomes pending rather than retaining the wrong file/alt text. A resolved slot also replaces a conflicting DOM media kind at that position; rows outside the resolved slots are not deleted. Once resolved, later DOM captures cannot override that Tweet's media. Text, first/last-seen, sticky relationships, initial-import marker, status and notes are not changed by resolution; historical results remain discoverable with `show`/`search` even if excluded from `pending`.

Deploy the receiver update **before** the updated extension, because the old fail-closed receiver rejects media payloads. Reload the built extension and X tabs for new captures. Manual scrolling remains useful for collecting **previously unknown Tweet IDs**, not required for media backfill of stored IDs. Validate backfill by enabling the resolver with existing text-only rows and confirming `x_media`/`x_media_resolution` changes without any browser interaction.

Separately enable the disabled `x-saved-media-download` example for image files:

```json
{
  "id": "x-saved-media-download",
  "schedule": "*/5 * * * *",
  "enabled": true,
  "handler": "jobs/x-saved-media-download.ts",
  "settings": { "limit": 20 }
}
```

This is a deterministic host handler, like `x-saved-backup`: no LLM, inbox job, separate worker, or independent timer/startup drain. Each run selects only `kind='image'`, pending before failed, with `limit` 1–100 (default 20). It directly HTTPS GETs `pbs.twimg.com` without cookies, OAuth, tokens, or third-party providers. The URL is revalidated before each request; redirects are rejected. It tries `name=orig` first and, only on failure, the original validated source URL. There is no other size/variant exploration. Each request/body is bounded by 15 seconds and 10 MiB, matching the existing `read` image byte limit. Only JPEG, PNG, GIF, and WebP response content types are saved.

Completed images use temporary-file + atomic rename into `media/<tweet_id>/<position>.<ext>` beside the DB (including when `X_SAVED_DB_PATH` is overridden). Paths use validated IDs/positions, never remote URL strings. SQLite stores only the relative path, e.g. `media/123/0.jpg`. Success sets `done` and clears `last_error`; individual failures set `failed`, clear `local_path`, record a short error, and do not interrupt other images or invalidate Tweet ingest. Failed images are eligible again on the next schedule, without retry counters/backoff. DB open/schema/update failures fail the cron job under existing runner semantics. Pending rows survive restart until the next normal cron run.

Videos remain `pending` with no source/local path. FxTwitter supplies their existence metadata, but **video file download/playback URL resolution is out of scope**. Tweet ID remains the locator for any future video processing. OCR, captioning, thumbnails, cleanup/retention, and automatic image-classification cron are not included.

## Configuration

The database and backup locations can be overridden with environment variables:

```bash
export X_SAVED_DB_PATH=/path/to/my-discord-agent/data/x-saved/x-saved.sqlite
export X_SAVED_BACKUP_DIR=/var/lib/my-discord-agent/x-saved-backups
```

The default database is `data/x-saved/x-saved.sqlite`. Backups default to `data/x-saved-backups`, outside the live database directory and therefore outside the sandbox mount. The backup directory must remain outside the live database directory.

Back up `x-saved.sqlite` and its backup files. Agent-managed status and notes cannot be reconstructed from an upstream service alone. The SQLite backup includes media metadata but **not image files**: back up `data/x-saved/media/` separately with the existing host filesystem backup. Restore matching files and DB together; this downloader does not rescan `done` rows for missing files.

`config/cron.example.json` contains a disabled `x-saved-backup` handler example. When enabled, it calls the generic backup operation once per schedule, retaining 14 backups by default. Set the optional `settings.keep` value to change retention; database and backup paths continue to come from `X_SAVED_DB_PATH` and `X_SAVED_BACKUP_DIR`.

## Give an agent access

Enable the `x-saved` skill and mount only the application-owned directory:

```json
{
  "tools": ["bash", "read"],
  "skills": ["x-saved"],
  "mounts": [
    {
      "host": "data/x-saved",
      "container": "/x-saved"
    }
  ]
}
```

The mount must be writable if the agent should use `mark` or `note`. Never mount source credentials or source databases into a sandbox. The existing directory mount already includes `media/`; no additional mount is needed. `pending`, `recent`, `search`, and `show` expose `media` entries with kind/status and a readable `path` such as `/x-saved/media/123/0.jpg` for completed images. Video entries have `path: null`, indicating presence without a downloaded file. Use `read` to inspect relevant images during triage, especially empty/short-text, media-centric Tweets; pending download is not evidence of low-value content. Updated skill templates must also be deployed to the group's installed skills.

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
- `x_media` — append/enrichment media metadata keyed by `(tweet_id, kind, position)`, image source/alt text, relative local path, pending/done/failed status, and a short last error. No BLOBs or file-size/MIME/hash/retry fields. Video rows currently have no source URL.
- `x_media_resolution` — per-Tweet last attempt and successful resolution timestamps; distinguishes unresolved from successfully media-less items independently of Extension state
- `x_sync_runs` — optional source health records, timestamps, errors, and new-item count
- `x_meta` — metadata such as the one-time `initial_import_completed_at` marker

Schema v4 adds `x_media` and `x_media_resolution` to existing v1/v2/v3 databases transactionally, without rewriting text or Agent state. Ordinary capture omission/empty arrays never delete rows; duplicate captures remain idempotent. Completed images retain their path/status/source on ordinary re-capture; pending/failed sources and supplied alt text can be enriched. Deleting an owning Tweet cascades to media and resolution rows; omission from DOM observations does not delete them. The store preserves its schema migrations and merge/upsert behavior for existing databases. In particular, missing incoming metadata does not erase stored metadata, relationship flags remain sticky, and existing item state and notes remain unchanged.
