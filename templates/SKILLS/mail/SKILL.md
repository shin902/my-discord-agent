---
name: mail
description: Read Outlook mail through the shared Tool Proxy. Use for listing messages and reading a selected message.
---

# Mail

Use the single public CLI to list or read mail:

```bash
python3 SKILLS/mail/scripts/mail.py --help
python3 SKILLS/mail/scripts/mail.py list --limit 10 --folder inbox --unread-only
python3 SKILLS/mail/scripts/mail.py read EMAIL_ID --no-mark-as-read
```

Every subcommand supports `-h` and `--help`. `read` preserves the existing `markAsRead` contract: it marks the message read by default; pass `--no-mark-as-read` to avoid that state change. The CLI only parses arguments and creates JSON for `tool-proxy`; Microsoft Graph credentials, folder/ID validation, schema validation, authorization, and API requests remain in the existing capability and Tool Proxy. Do not read credentials or use a direct Graph fallback.
