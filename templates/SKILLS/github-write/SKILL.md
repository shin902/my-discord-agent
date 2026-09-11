---
name: github-write
description: Post an explicitly requested comment to a GitHub Issue through the shared Tool Proxy. Use only after confirming the target and text.
---

# GitHub write

Post a Markdown comment to one Issue:

```bash
bash SKILLS/github-write/scripts/comment-issue.sh OWNER REPO ISSUE_NUMBER "Comment body"
```

`comment-issue.sh -h` and `comment-issue.sh --help` show the positional arguments and the `--body` alternative. The script only converts arguments to JSON and calls `tool-proxy comment-issue`; credentials, Issue/owner validation, schema validation, authorization, and the actual mutation remain in the existing capability and Tool Proxy. Confirm the repository, Issue number, and complete body before invoking it. Never use a direct GitHub API fallback.
