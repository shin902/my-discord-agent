---
name: mail
description: List and read Outlook email through the configured account.
---

# Mail

Capabilities and uses:

- `list-emails`: list mailbox messages
- `read-email`: read a message

First retrieve only the capability you need, then follow its description (including safety requirements) and parameters when constructing raw JSON:

```bash
# Read the canonical Tool contract without executing it
bash SKILLS/mail/scripts/mail.sh list-emails
# Execute with JSON matching that contract
bash SKILLS/mail/scripts/mail.sh list-emails '{}'
```

The script does not parse or transform arguments. Skill selection does not grant permission: the run must allow the capability through native `tools` or trusted `toolSets` (normally `mail`).
