---
name: mail
description: List and read Outlook email through the configured account.
---

# Mail

Pass the capability's JSON arguments unchanged:

```bash
bash SKILLS/mail/scripts/mail.sh list-emails '{"folder":"inbox","unreadOnly":true}'
bash SKILLS/mail/scripts/mail.sh read-email '{"id":"EMAIL_ID"}'
```

Capabilities: `list-emails`, `read-email`.

The script does not parse or transform arguments. Use the capability's canonical Tool schema when constructing the JSON object.
