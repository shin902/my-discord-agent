# AGENTS.md

Repository-wide instructions for coding agents. Keep this file short; task-specific procedures live in `.pi/skills/`.

## Development

- Node.js 22+ and `pnpm`.
- Prefer narrow changes. Do not mix unrelated refactors or cleanup into a task.
- Follow existing architecture and tests before inventing new abstractions.

Common commands:

```bash
pnpm dev
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm format
pnpm format:check
```

After writing or editing a Biome-supported file, run Biome on the changed file immediately instead of leaving formatting cleanup until the end:

```bash
pnpm exec biome check --write <changed-file>
```

Before push or reporting a code change complete, run the same checks as CI and fix failures:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

## Architecture invariants

- Normal agent tools run inside the sandbox container. Do not give them direct host filesystem or process access.
- Secrets stay outside agent-visible state. Use the Credential Proxy boundary instead of exposing tokens, cookies, or API keys.
- Do not weaken sandbox, credential, queue, or delivery boundaries as a convenience for a local change.

## Runtime database

`data/runtime.sqlite` is the durable runtime/queue source of truth; `RUNTIME_DB_PATH` may override it. Important tables include `jobs`, `deliveries`, `idempotency_keys`, and `discord_sync_cursors`.

Do not reason from the old JSONL queue design. Inspect runtime state read-only by default, and do not hand-edit queue state with ad-hoc `UPDATE`/`DELETE` statements without understanding leases, fencing, retries, delivery state, and idempotency.

For runtime DB inspection, use the `runtime-db` skill.

## Configuration

Configuration is split by responsibility. Use the matching skill before changing or diagnosing it:

- `config-core` — `config/config.json`, global runtime/default settings, Discord bot definitions.
- `config-groups` — `config/groups.json`, channels, session modes, tools, skills, mounts, per-group agent settings.
- `config-providers` — `config/providers.json`, `config/credentials.json`, providers, credentials, API endpoints, concurrency.
- `config-cron` — `config/cron.json` and generic scheduled jobs.
- `config-rss` — RSS collect/dispatch configuration and RSS-specific cron settings.

Use example files and the relevant docs as the source of truth; do not guess config schema from memory.

## Documentation

When behavior, configuration, examples, or operator workflows change, use the `update-docs` skill to check whether repository documentation must change too.
