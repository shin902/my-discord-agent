---
name: "finance-setup"
description: "Retired: finance database initialization and migration are handled automatically by the trusted finance Runtime. Do not invoke this skill."
---

# finance-setup (retired)

This skill is retained only as a migration marker for installations that still contain the old file. It is not an Agent-facing operation.

The purpose-specific finance tools create a missing database and apply compatible schema migration internally. Use those tools directly; never run setup commands, direct SQL, or choose a database path or mount.
