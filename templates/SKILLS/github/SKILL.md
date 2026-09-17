---
name: github
description: Read, list, and comment on GitHub issues and pull requests.
---

# GitHub

Pass the capability's JSON arguments unchanged:

```bash
bash SKILLS/github/scripts/github.sh list-issues '{"owner":"owner","repo":"repo","state":"open"}'
bash SKILLS/github/scripts/github.sh read-issue '{"owner":"owner","repo":"repo","issue_number":123}'
```

Capabilities: `list-issues`, `read-issue`, `read-pull-request`, `list-issue-comments`, `list-pull-request-comments`, `comment-issue`.

The script does not parse or transform arguments. Use the capability's canonical Tool schema when constructing the JSON object.
