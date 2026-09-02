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

## Discord command extension contract

- Add one module under `src/discord/commands/` exporting `command: DiscordCommandDefinition`; its `data` is a `SlashCommandBuilder` and its `execute(interaction, context)` delegates through the Discord adapter (`src/discord/command-handlers.ts`) to the plain-request use cases in `src/application/discord-command-service.ts`. Register the module in `src/discord/command-registry.ts`; adapters must not import config, queue repositories, sessions, or `AgentManager`.
- `src/discord/interaction-router.ts` owns lookup and unexpected-error logging. Commands decide when to defer and use `editReply`; validation and expected failures use an ephemeral `reply` (or edit after defer). The runtime only registers the router and does not deploy commands.
- `src/discord/command-registry.ts` is the authoritative source for every Slash Command in this application. Deploy uses Discord bulk overwrite to replace the same complete command set in the selected global or guild scope for every configured Discord application; commands registered manually or by another system in that same scope are intentionally removed on the next deploy. Deploy scope is mandatory, and runtime startup does not deploy commands. The implicit default Bot uses `DISCORD_APPLICATION_ID` / `DISCORD_BOT_TOKEN`; additional Bot applications use `discord.bots` application IDs and token environment references.
- Verify with `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Deploy independently with `pnpm discord:deploy -- global` or `pnpm discord:deploy -- guild <guild-id>` using `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN`; guild deploy is for fast checks, global deploy can take time to propagate.
