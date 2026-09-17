---
name: github
description: Read, list, and comment on GitHub issues and pull requests.
---

# GitHub

Capabilities and uses:

- `list-issues`: list repository issues
- `read-issue`: read an issue
- `read-pull-request`: read a pull request
- `list-issue-comments`: read issue comments
- `list-pull-request-comments`: read pull request comments and reviews
- `comment-issue`: post an issue comment

First retrieve only the capability you need, then follow its description (including safety requirements) and parameters when constructing raw JSON. Set the `bash` Tool's `timeoutMs` to `130000` for every script call; this is only an outer ceiling, while each capability keeps its own runtime timeout.

```bash
# Read the canonical Tool contract without executing it
bash SKILLS/github/scripts/github.sh read-issue
# Execute with JSON matching that contract
bash SKILLS/github/scripts/github.sh read-issue '{"owner":"owner","repo":"repo","issue_number":123}'
```

The script does not parse or transform arguments. Skill selection does not grant permission: the run must allow the capability through native `tools` or trusted `toolSets` (normally `github`).
