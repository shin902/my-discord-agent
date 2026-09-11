---
name: mail
description: Read Outlook mail through the shared Tool Proxy. Use for listing messages and reading a selected message.
---

# Mail

Use the thin scripts to list or read mail:

```bash
bash SKILLS/mail/scripts/emails.sh --limit 10 --folder inbox --unread-only
bash SKILLS/mail/scripts/email.sh EMAIL_ID --no-mark-as-read
```

Every script supports `-h` and `--help`. `email.sh` preserves the existing `markAsRead` contract: it marks the message read by default; pass `--no-mark-as-read` to avoid that state change, or `--mark-as-read` explicitly. The scripts only parse arguments and create JSON for `tool-proxy`; Microsoft Graph credentials, folder/ID validation, schema validation, authorization, and API requests remain in the existing capability and Tool Proxy. Do not read credentials or use a direct Graph fallback.
