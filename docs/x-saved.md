# X saved items

`x-saved` stores saved X/Twitter posts as durable local data that agents can search and triage without receiving credentials.

The repository owns the local SQLite database at `data/x-saved/x-saved.sqlite`. Its containing directory (database and archived media, no source credentials) is mounted into an agent sandbox:

```text
my-discord-agent
  data/x-saved/{x-saved.sqlite,media/}
       |
       | configured mount
       v
agent sandbox
  /x-saved/{x-saved.sqlite,media/}
  + x-saved skill / read
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
      { "kind": "image", "position": 0, "source_url": "https://pbs.twimg.com/media/Example.jpg", "alt_text": "A diagram" },
      { "kind": "video", "position": 1 }
    ]
  }],
  "idempotency_key": "optional-request-id"
}
```

Tweet IDs are positive decimal strings of at most 20 digits. `text` is required (empty text is valid for media-only posts), up to 100,000 characters. `url` must be an `https://x.com/<handle>/status/<tweet_id>` URL with a matching ID. `kind` is `like` or `bookmark`. `author` may be a handle with or without `@` and, when nonempty, must match the URL handle case-insensitively; `created_at` is an ISO timestamp with a timezone. Omitted or empty author/timestamp metadata is preserved in existing rows. Unknown fields and invalid items reject the entire batch before database access. External URL metadata is deliberately omitted by this adapter, preserving stored values. The extension applies the same item validation before IndexedDB persistence so invalid captures cannot enter the outbox and block later batches.

Optional `media` is a best-effort DOM hint, never a completeness signal. Image entries require a validated HTTPS `pbs.twimg.com/media/<identifier>` URL (max 2,048 characters) and may include `alt_text` (max 10,000 characters). Video hints contain only `kind` and `position`, not source URLs. Positions are integers 0–15 across media kinds; at most 32 distinct `(kind, position)` entries are accepted. Unknown fields, duplicate keys and unsafe URLs reject the batch. Omitted or empty media does not retract existing rows.

The receiver performs no network lookup/download: items, state and optional hints commit in one transaction. Only after the SQLite transaction commits does the receiver return `200` with `{"accepted":["like:123"]}`. Keys are unique `kind:tweet_id` values. Retries rely on item-level upserts, with no request ledger. Like and Bookmark captures merge into one Tweet row; existing status and notes remain intact.

Errors return JSON without `accepted`: `400` for invalid JSON/batches, `413` for oversized bodies, `415` for unsupported content type/encoding, and `500` for a failed database commit. Other paths return `404`, and other methods return `405`. Web-page origins are rejected (`403`); extension service-worker requests use Chrome host permissions and need no web-page CORS access.

To verify an installation, capture a Like and a Bookmark in Chrome and check the local database within a few seconds. For recovery, stop the receiver, capture another item, confirm the popup shows it pending, restart the receiver, and use `Sync pending items`. Confirm only acknowledged entries disappear. These browser/Tailnet checks require the installed extension and live runtime; automated HTTP/SQLite and extension tests cover the protocol separately.

## Media archive and context enrichment: one host cron

**Tweet ID is the canonical locator.** The extension is a sensor for collecting saved IDs, with optional first-capture hints. Its normal `kind:tweet_id` sent/inFlight/seen/outbox/ACK behavior is unchanged; there is no media-aware dedupe or enrichment replay. Already stored text-only Tweets can be backfilled without Mac re-scrolling, re-sending, or an IndexedDB reset.

Enable the single disabled `x-saved-media-download` example deliberately, then restart the runtime:

```json
{
  "id": "x-saved-media-download",
  "schedule": "*/5 * * * *",
  "enabled": true,
  "handler": "jobs/x-saved-media-download.ts",
  "settings": { "limit": 20 }
}
```

This is a deterministic host handler, not an Agent/LLM job. Each run has three sequential phases, each bounded by the same `limit` (1–100, default 20):

1. Select unresolved `x_items`, never-attempted first then oldest attempt. Update `media_resolve_attempted_at`, look up **only the Tweet ID** through `https://api.fxtwitter.com/2/status/<id>`, upsert media and set `media_resolved_at` atomically on success. Empty media is also success and is not repeatedly looked up. Failures remain unresolved and rotate behind other IDs on later runs.
2. Download pending/failed `x_media`, pending first. Save one image or one MP4 into a sibling temporary file, count streamed bytes, then atomically rename and commit a relative `local_path` / `done`. Individual failures become `failed` with `last_error`; other files continue and failed sources retry next run. A video without direct MP4 is marked failed and excluded from repeated download attempts while its source remains absent.

3. Backfill context from `https://api.fxtwitter.com/2/thread/<id>` for saved IDs with no completed `x_enrichment` snapshot (including snapshots missing the focal author's ID). Never-attempted IDs precede oldest attempts. Store the snapshot and `resolved_at` together; individual network/validation failures retain `last_error`, continue the batch and retry on later runs. This phase is independent of media completeness, so old completed archives and new captures both qualify without browser replay.

FxTwitter's current [v2 API schema](https://github.com/FixTweet/FxTwitter/blob/main/packages/atmosphere/src/types/api-schemas.ts) is validated: matching focal status ID/type/provider, ordered `media.all`, supported image/video/gif entries. Quotes, cards, avatars, thumbnails and mosaic URLs are not archive sources. The highest-bitrate direct MP4 format is selected; a direct top-level MP4 URL is usable when formats are absent. HLS-only videos retain presence metadata but cannot be archived. No HLS, ffmpeg, variant table, provider abstraction, resolver queue or second cron is involved.

Like Agent Reach's existing FxTwitter fetch policy, lookup is credential-free, redirect-free, bounded to 20 seconds and 2 MiB. The archive uses v2's ID-only endpoint instead of Agent Reach's handle-based text endpoint. Only saved Tweet IDs are sent to FxTwitter, never saved-state flags, text, notes, cookies or tokens. Deleted/private/unavailable posts can remain unresolved; this public third-party service is not a completeness guarantee for inaccessible posts.

### Saved context

`x_enrichment.document_json` contains `status` and an ordered `thread`, including the saved focal post. The thread endpoint reconstructs available ancestors and descendants; other authors' statuses are excluded and provider tombstones preserve unavailable gaps. A successful null/empty thread becomes a focal-only thread. Availability is limited to what FxTwitter returns, not a promise of a complete historical thread.

Each available status retains text, ID, URL, creation time, `author` (`id`, `screen_name`, `name`, nullable `avatar_url`, optional profile `url`), `raw_text.facets` (including expanded `replacement` URLs), derived `external_urls`, one inline `quote` with its author/text/basic metadata, and the full `article` document including title, content blocks and entity map. Nested quotes are stripped. Missing quote/article are explicit `null`; missing URLs are `[]`. Successfully resolved absence is complete and is not polled again. Missing required author data or a preview-only Article is a retryable validation failure; oversized responses fail rather than silently truncating Article text.

No conversation/reply-tree, profile/timeline, external-page or recursive quote lookup is performed. These URLs and Article entities are stored as untrusted data, never followed or downloaded by enrichment. Existing Tweet text, external URL fields, source history, status/notes/labels and archived media are untouched. Gallery detail displays the saved self-thread; Gallery grid and existing Skill list/search output are unchanged. The stored context is also directly readable from SQLite without another lookup:

```sql
SELECT document_json, resolved_at, attempted_at, last_error
FROM x_enrichment WHERE tweet_id = '123';
```

### Files and trust boundary

| Kind | Allowed source | Fixed limits | Local file |
|---|---|---|---|
| Image | `https://pbs.twimg.com/media/...` | 10 MiB, 30 seconds per attempt | `media/<tweet_id>/<position>.jpg/png/webp/gif` |
| Video / animated GIF | `https://video.twimg.com/{ext_tw_video,amplify_video,tweet_video}/...mp4` | 512 MiB, 5 minutes | `media/<tweet_id>/<position>.mp4` |

Images try `name=orig` first, then the supplied URL only if that attempt fails. Video downloads save one MP4, without re-encoding. Both stream directly to disk; no whole-binary buffering, resume or range requests. Only allowed image MIME types / `video/mp4` are accepted. URLs are revalidated before every fetch: HTTPS, exact CDN host and path, no URL credentials, non-default port or fragment, and **no redirects**. Arbitrary URLs from FxTwitter are not trusted. Numeric Tweet IDs/positions and non-symlink media directories constrain local paths. Temporary files are removed on handled failures; a process crash can leave a `.part` file, never a published partial archive.

Files live beside the database under `data/x-saved/media/` (or under the configured DB parent). Completed rows/files are retained as archived snapshots on later capture or lookup, not reset or replaced; pending sources can be completed by FxTwitter. Missing incoming entries never delete media. Hints arriving after successful resolution cannot override resolved media. Media processing does not change Tweet text/timestamps, sticky history, initial-import markers, Agent status or notes.

DB/schema/transaction errors fail the entire cron instead of being swallowed as per-item failures. A crash after file rename but before DB commit may cause that pending file to be downloaded again. No separate filesystem/SQLite transaction or retry ledger is added. Long sequential video downloads delay the enrichment phase and the next run of this job; reduce `limit` on slow links.

### Rollout

Back up SQLite and media separately before upgrading to schema v5. Deploy host receiver/cron/Gallery code together: older host binaries reject the newer schema. The existing enabled media cron automatically backfills context after upgrade; no extension update, re-scroll or second cron is needed for enrichment. With the browser closed, verify `x_enrichment.resolved_at`/`document_json` for an existing ID and inspect `last_error` for retries. Automated tests cover fresh context, full Article text, thread order, quotes/authors/facets, resolved absence, v4 migration, bounded retry selection, database failures and preservation of existing saved state. Live FxTwitter availability and production rollout require separate operator verification.

Deploy the receiver before reloading the updated extension (old strict receivers reject media fields). Install updated Skill templates, retain the existing directory mount, then enable the archive cron. No production configuration is changed automatically. Verify existing IDs resolve with the browser closed, confirm image/MP4 paths, and use Agent `read` on a downloaded image. Mac Chrome/Tailscale new-capture checks are still needed for installation validation, but not for stored-ID media backfill.

## Local automatic classification (PixAI)

`jobs/x-saved-classify.ts` is an opt-in **host-only, non-Agent** cron. It runs `scripts/x-saved-tagger.py` in a dedicated Python environment, separately from media downloading. No LLM, VLM, OCR, remote image upload, file relocation, or new service is involved. Inference uses the local **PixAI Tagger v1.0** snapshot at revision `f33cfdb53c0c90b049bab9ce066eea1118970ef8` (May 2026 cutoff). Unknown/new characters outside its vocabulary cannot be recognized.

The model has custom Python code. The pinned code was inspected, but this repository does not redistribute its code or weights. **The upstream model card does not currently specify a license; availability is not a license grant. Confirm applicable usage/distribution terms with PixAI before production use or redistribution.** Our integration does not resolve that uncertainty.

### Install and smoke-test

Keep the Python environment and model cache **outside `data/x-saved/` and all Agent mounts**. The classifier rejects a cache inside the archive directory. Example CPU setup (Python 3.12, approximately 2 GB of model weights plus dependencies):

```bash
uv venv --python 3.12 data/x-saved-tagger/venv
uv pip install --python data/x-saved-tagger/venv/bin/python \
  torch==2.10.0 torchvision==0.25.0 --index-url https://download.pytorch.org/whl/cpu
uv pip install --python data/x-saved-tagger/venv/bin/python \
  transformers==4.57.6 timm==1.0.24 Pillow==12.1.1
cp config/x-saved-aliases.example.json config/x-saved-aliases.json
# Explicit one-time network download of the fixed snapshot; does not touch SQLite.
data/x-saved-tagger/venv/bin/python scripts/x-saved-tagger.py \
  --cache data/x-saved-tagger/cache --download
```

Normal execution is offline (`local_files_only`, HF offline/telemetry disabled). The upstream preprocessing and FP32 inference are retained; images are processed sequentially, and the model is loaded once per batch only when needed. CPU defaults to four OpenMP/MKL threads, overridable with `OMP_NUM_THREADS` / `MKL_NUM_THREADS`. For CUDA or MPS, install compatible PyTorch packages and set `device` accordingly; there is no silent device fallback. CUDA/MPS are not covered by the CPU smoke check.

Back up the existing SQLite database first and use a **disposable archive copy** for initial classification/threshold calibration. Run the current host once to create/migrate the archive to schema v5, then:

```bash
data/x-saved-tagger/venv/bin/python scripts/x-saved-tagger.py \
  --db /path/to/disposable-archive/x-saved.sqlite \
  --aliases config/x-saved-aliases.json --cache data/x-saved-tagger/cache \
  --device cpu --limit 1
```

This command **writes labels** to the specified database. Inspect the result before enabling the disabled `x-saved-classify` example in `config/cron.example.json`, and restart the host after changing cron settings. Relative cron paths resolve from the repository root. Use one classifier job/process per archive; do not overlap manual runs with the cron. Each run handles at most `limit` Tweets (1–100, default 20), with a 30-minute process timeout. Reduce the limit for slow CPUs or many-image Tweets. A killed batch retains already committed Tweets; the interrupted Tweet is retried.

### Alias dictionary and merge policy

The alias file is JSON, not hand-written regular expressions. It has `series`, `characters`, and `tags` maps. Each canonical label has `aliases: string[]`; a character may also specify `series` referencing a canonical series entry. See `config/x-saved-aliases.example.json`. Include alternate model spellings in the same alias list when necessary. Ambiguous aliases and unknown series references fail validation before writing.

1. Scan Tweet text with escaped literal aliases and canonical names. NFKC/case folding handles width/case differences; ASCII word boundaries prevent `ai` matching inside `mail`, while Japanese aliases match substrings. Adopt all matched labels, including explicit character-to-series mappings.
2. Pass **every completed image** through PixAI, even if text already supplied a classification. Animated image files use their first frame; MP4/video and text-only Tweets are not classified by this job. Pending/failed downloads use text aliases for now and reopen automatically when the archive row changes. Missing/corrupt completed files remain retryable failures.
3. Map `copyright -> series`, `character -> character`, `general -> tag`. Style/meta/rating outputs are deliberately excluded. Normalize labels with NFKC/case folding and whitespace-to-underscore, canonicalize through the dictionary, and union/dedupe across images. Default inclusive thresholds are copyright **0.46**, character **0.37**, general **0.34** (the upstream micro-F1 starting points, **not** a local accuracy guarantee). Override them with cron `settings.thresholds` or CLI `--thresholds '{"character":0.6}'`.
4. Add labels to `x_item_labels`, **never delete existing labels or alter status/notes/media**. Image-derived additions are ranked by maximum confidence across images, with lexical tie-breaking, and fill up to 50 values per kind including existing/text labels. Text matches and existing labels are never truncated; unusually large alias dictionaries can therefore exceed Gallery's 50-value editing limit. All successful image labels and the completion checkpoint commit together. If any image fails, text matches remain, image additions are deferred, and `last_error` records the failure. DB errors fail the job rather than masquerading as image errors.

No schema migration or second database is needed. `x_meta` keys `pixai-v1:<tweet_id>` hold the input fingerprint, last attempt time, and last error. The fingerprint covers the pinned model/policy, dictionary, thresholds, Tweet text, and image row states/paths. Unchanged successful Tweets are skipped, preserving subsequent human removals; failures rotate behind never-attempted Tweets and retry on later runs. Later images, text, dictionary, or threshold changes reopen the Tweet and may **re-add previously removed predictions**. Raising a threshold does not retract old labels. This additive policy has no provenance ledger or manual-label lock; edit after backfill and pause the cron while correcting labels. In-place replacement of archived image bytes at an unchanged path is not detected (normal archiving does not replace completed files).

```sql
SELECT key, json_extract(value, '$.last_error') AS last_error
FROM x_meta WHERE key LIKE 'pixai-v1:%';
```

Automated checks use temporary SQLite/image fixtures and a fake inference function; `pnpm test` runs them without model downloads. A separate real-model CPU smoke verified local loading, inference, label persistence, and unchanged-input skipping on a synthetic image. It does **not** measure anime recognition quality. Production saved-image accuracy/thresholds and GPU performance still require operator validation. Alias mining and automatic dictionary updates are not implemented.

## Gallery: browse and edit over Tailscale

Gallery is an opt-in, human-facing viewer/editor of the **same SQLite and media archive**, not a second store. It uses server-rendered HTML, native forms and video controls; no client framework, JavaScript bundle, pairing, or external assets are needed.

**Threat model:** Gallery is a single-user localhost service with Tailscale Serve as its only external entry point; the host's SQLite, media archive and local processes are trusted, while external Tweet content remains untrusted. Gallery does not defend against host compromise or malicious local archive/symlink changes.

### Setup and access

In `config/config.json`, configure the exact HTTPS origin shown by Tailscale Serve:

```json
{
  "xSavedGallery": {
    "enabled": true,
    "port": 8789,
    "origin": "https://your-host.your-tailnet.ts.net"
  }
}
```

Gallery defaults to disabled / port 8789. When enabled, `origin` is required for form POST validation; malformed settings fail startup. It must be an HTTPS `.ts.net` origin, with no trailing slash/path/query; include the HTTPS port if not 443. Remove `allowedLogin` from any earlier Gallery configuration: it is no longer a supported setting. Restart the application after changes.

Inspect existing Serve handlers before assigning a free HTTPS port, then expose **only the Gallery listener**:

```bash
tailscale serve status
tailscale serve --bg --https=443 http://127.0.0.1:8789
tailscale serve status
```

Open the configured origin from your Mac, iPhone or iPad connected to the Tailnet. **Restrict access to the Serve endpoint to yourself in Tailscale's access policy before enabling it.** Serve does not by itself restrict access to the owner: anyone allowed to reach the endpoint can view and edit Gallery. The backend binds only `127.0.0.1`; there is no configurable public bind and no Gallery pairing, token, or Tailscale identity check. Direct localhost access is also trusted and unauthenticated. Do not use Funnel, a public proxy, or port forwarding.

The receiver and Gallery have **separate ports/listeners/routes/authentication**. Gallery can be enabled with the receiver disabled. Both enabled on the same port fail startup. Do not expose the receiver just to enable Gallery, or replace its existing capture authentication/deployment with the Gallery settings. Gallery does not accept ingest requests. Shutdown closes both listeners and the Gallery database connection.

Only GET and POST are accepted. Writes require `Origin` to match the configured Gallery origin; there is no CORS grant. Tweet text, labels and other rendered values are HTML-escaped, and SQL values use parameter binding. Media routes address `(tweet_id, kind, position)` and open only `media/<tweet_id>/<position>.<ext>` for completed rows. The existing `local_path` supplies only an allowed image/MP4 extension, never the path to open, preserving JPG/PNG/WebP/GIF support without moving files. Native MP4 single-byte-range responses support playback/seeking without loading entire videos into memory; unsupported range forms receive the full file.

### Browsing and classification

- Grid: one card per media row, **60 cards per page**, lazy-loaded original images, Tweet excerpt, author, status and classification labels. Video cards open native MP4 preview/controls in detail; no thumbnail store or eager video-grid download is added. Pending/failed archives show placeholders. Text-only Tweets are not in the grid.
- Search is a literal Tweet-body substring (ASCII case-insensitive); `%` and `_` are not wildcards. Media (`image` / `video`), sticky source (`like` / `bookmark`), status, exact author handle (optional `@`, case-insensitive), and classification filters combine with AND.
- Series, characters and tags are multi-valued. Filters and editing use **one value per line**; commas are literal, so a legacy tag such as `AI,ML` remains one value. Filters require **all specified values**, with exact, case-sensitive matching. Labels are ordinary short, single-line strings; lines are trimmed/deduplicated. There is no JSON syntax or fallback. Editing replaces that Tweet's labels; an empty field clears it. Validation caps each field at 50 values and each value at 100 characters; these are upper bounds, not an end-to-end guarantee at all combined maxima.
- `Unknown` means missing series **or** characters. A literal `unknown` label has no special meaning. `Needs review` means **only** the existing `inbox` status, independently of whether classification is complete. These are filters, not new stored statuses; `reviewed`, `keep`, `try`, `done`, `ignore` retain their existing meaning. Optional automated classification is described in [Local automatic classification](#local-automatic-classification-pixai).
- Inclusive UTC date filters use the Tweet creation date, falling back to first capture when unavailable. Sort by first capture newest, Tweet newest/oldest, or author; page ties are stable. Ordinary filter/page state is retained directly in the query through detail/edit and the return link, without a nested `back` URL. A short `303 Location: #saved` retains the query after saving. Node's default request-header limit is unchanged; Gallery does not expand browser/server limits for huge URLs.
- Detail shows the saved self-thread in snapshot order, including author/name, handle, body, posting time and ID-derived original Tweet links. The saved focal Tweet is marked; tombstones appear as unavailable gaps. Missing, failed or unusable enrichment leaves the normal detail available. This is a local snapshot view without network lookups, quote/Article UI or additional media downloads; external text is HTML-escaped.
- Detail edits are **Tweet-wide**, applying to every image/video in that Tweet, not separate copies per card. Status and labels commit together; notes, Tweet metadata, source flags, archive files and paths remain untouched. Ingest and media cron never overwrite classification; the optional classifier adds labels under its documented merge policy. Invalid/failed edits retain the submitted form values for correction/retry.

**Support scope:** normal browsing/search and a few to a few dozen tags or filters. Artificial maximum-size combinations (including 50 × 100-character labels), 100,000-character filter URLs and lossless editing of unusual legacy values containing embedded newlines, NUL or surrounding whitespace are not requirements. Do not use Gallery to round-trip those unusual legacy values: saving applies ordinary line splitting and trimming. Review fixes should target problems encountered in normal use, not complete coverage of theoretically constructible inputs.

SQLite remains authoritative. Receiver, archive cron, Skill and Gallery use normal SQLite WAL transactions/busy timeout; there is no new writer queue, lock service or conflict-resolution layer. Single-user edits are last-writer-wins. Refresh an already-open page to see changes from another device/Skill. OFFSET pagination and original-image loading target hundreds to thousands of media; fast scrolling still depends on archive image sizes and network bandwidth.

### Upgrade and verification

Back up the SQLite database with its existing online backup mechanism and media separately before deploying. Schema v4 adds `x_item_labels` without moving media or resetting state. Update host receiver/cron/Gallery code together: older host binaries reject newer schema versions. No production config or Tailscale Serve settings are changed automatically.

The HTTP/SQLite tests cover migration, 2,000-media pagination, combined filters, transactional edits, preserved ingestion, CSRF, escaping, route-derived archive paths, native MP4 ranges, comma-containing tags, and the separate Unknown / Needs review semantics. CI also runs a desktop/mobile browser smoke using local HTTP fixtures with the browser's local POST origin translated to the configured HTTPS origin (not a live Tailnet). To run that smoke locally:

```bash
pnpm exec playwright install chromium
X_SAVED_GALLERY_BROWSER_TEST=1 pnpm exec vitest run src/integrations/x-saved/gallery.test.ts
```

After enabling in production, verify image/video playback and one classification edit from your own user devices; confirm Tailscale's access policy denies other users and existing receiver capture still works. These live Tailnet/device checks are separate from the automated local smoke.

## Configuration

The database and backup locations can be overridden with environment variables:

```bash
export X_SAVED_DB_PATH=/path/to/my-discord-agent/data/x-saved/x-saved.sqlite
export X_SAVED_BACKUP_DIR=/var/lib/my-discord-agent/x-saved-backups
```

The default database is `data/x-saved/x-saved.sqlite`. Backups default to `data/x-saved-backups`, outside the live database directory and therefore outside the sandbox mount. The backup directory must remain outside the live database directory.

Back up `x-saved.sqlite` and its backup files, and back up `data/x-saved/media/` separately. SQLite backups do not contain image/MP4 binaries. Agent/human-managed status, notes and classification labels cannot be reconstructed from an upstream service alone.

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

`pending`, `recent`, `search` and `show` include media `kind`, `status`, `position`, alt text and completed `/x-saved/media/...` paths. The Skill remains usable before migration (empty media lists). Use `read` for images when they inform classification. MP4 paths are visible as archives only; no video-understanding tool or thumbnail generation is added.

## Daily and weekly triage

`config/cron.example.json` contains disabled examples for:

- `x-saved-daily` — process a bounded `pending` batch, inspect external links only when necessary, update state, and use `<NO_REPLY>` if nothing is worth surfacing.
- `x-saved-weekly` — resurface high-value `keep` / `try` items and stale experiments once a week.

These are normal declarative agent cron jobs. Their `mounts` field replaces inherited mounts, so include every mount the job needs.

## Data model

`seen_liked` and `seen_bookmarked` are sticky history flags. If a source no longer reports a relationship, the local record remains searchable. Agent-managed status and notes are stored in the local database and are not overwritten by ingestion.

The durable state is `data/x-saved/x-saved.sqlite`:

- `x_items` — post body, author, URL, sticky like/bookmark history, ingest timestamps, nullable `media_resolved_at` / `media_resolve_attempted_at`
- `x_item_state` — `inbox`, `reviewed`, `keep`, `try`, `done`, or `ignore`, plus an optional note and update time
- `x_media` — `(tweet_id, kind, position)` primary key, source/alt text, relative file path, pending/done/failed status and last error; cascading ownership by `x_items`
- `x_enrichment` — one context snapshot per saved Tweet (`document_json`), nullable `resolved_at`, `attempted_at` and `last_error`; cascading ownership by `x_items`, independent of media resolution
- `x_item_labels` — `(tweet_id, kind, value)` primary key; multi-valued `series`, `character`, `tag`, with a lookup index and cascading ownership by `x_items`
- `x_sync_runs` — optional source health records, timestamps, errors, and new-item count
- `x_meta` — metadata such as the one-time `initial_import_completed_at` marker

Schema v5 adds `x_enrichment` without rewriting existing rows. Snapshot authors are required for successful resolution; an absent row, null completion marker or missing focal author ID qualifies for automatic backfill. Context-only thread/quote posts are embedded in the snapshot, not inserted as newly saved `x_items`.

Schema v4 adds `x_item_labels`. If a legacy `x_tags` table remains, valid nonempty trimmed tags (up to 100 characters) are imported once; the legacy table is retained unchanged, including values outside those limits. The current Gallery uses only `x_item_labels`, with no dual writes to legacy tables. Schema migration checks the version inside SQLite's write transaction so simultaneous opens cannot apply it twice.

Schema v3 transactionally adds `x_media` and the two nullable timestamps to existing v1/v2 databases without resetting item state. DOM hints never set `media_resolved_at`. Media resolution stores no hashes, dimensions, bitrate or retry counters; context metadata lives separately in the v5 snapshot. The store preserves its schema migrations and merge/upsert behavior for existing databases. In particular, missing incoming metadata does not erase stored metadata, relationship flags remain sticky, and existing item state and notes remain unchanged.
