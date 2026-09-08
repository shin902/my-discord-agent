---
name: x-saved
description: "Search and triage locally saved X/Twitter likes and bookmarks. Use for remembered X posts, saved-item search, recent bookmark/like review, or marking items keep/try/done/ignore."
---

Use the local `/x-saved/x-saved.sqlite` through the bundled script. Do not access credentials or X directly from this skill.

```bash
python3 SKILLS/x-saved/scripts/x-saved.py status
python3 SKILLS/x-saved/scripts/x-saved.py pending --limit 20
python3 SKILLS/x-saved/scripts/x-saved.py recent --collection bookmarks --limit 20
python3 SKILLS/x-saved/scripts/x-saved.py search "Strix Halo" --limit 20
python3 SKILLS/x-saved/scripts/x-saved.py show <tweet-id>
```

## Triage

`pending` excludes items imported during the initial historical import. Newer items are eligible for triage:

```bash
python3 SKILLS/x-saved/scripts/x-saved.py mark <tweet-id> reviewed
python3 SKILLS/x-saved/scripts/x-saved.py mark <tweet-id> keep
python3 SKILLS/x-saved/scripts/x-saved.py mark <tweet-id> try
python3 SKILLS/x-saved/scripts/x-saved.py mark <tweet-id> done
python3 SKILLS/x-saved/scripts/x-saved.py mark <tweet-id> ignore
python3 SKILLS/x-saved/scripts/x-saved.py note <tweet-id> "llama.cppで試す"
```

Statuses:

- `inbox` — not reviewed yet
- `reviewed` — reviewed, no stronger action needed
- `keep` — worth retaining and resurfacing
- `try` — worth testing or acting on
- `done` — action completed
- `ignore` — low value for future use

## Rules

- Search local data first when the user refers to an X post they previously liked/bookmarked.
- `seen_liked` / `seen_bookmarked` mean the relationship was observed at least once; X-side removal does not erase local history.
- For a triage cron, call `status` first to inspect the local database state.
- Inspect external links with an allowed web-reading skill only when the post itself is insufficient to classify it.
- In scheduled triage, process a bounded batch and mark every reviewed item. If nothing is worth surfacing, return `<NO_REPLY>` when the cron permits it.
