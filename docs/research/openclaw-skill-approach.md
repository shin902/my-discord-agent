OpenClawはpi-agent-coreをベースにしていますが、スキル機能はOpenClaw独自のレイヤーで実装されています。pi-agent-coreはエージェントループとツール実行を提供し、OpenClawがその上にスキルシステムを構築しています [1](#0-0) [2](#0-1) 。

---

## スキルの実装仕組み

### スキルの形式と注入

スキルは`SKILL.md`ファイルとして保存され、システムプロンプトに注入されることでエージェントに指示を与えます [3](#0-2) [4](#0-3) 。OpenClawはエージェントの実行時に、利用可能なスキルのリストをコンパクトなXML形式でシステムプロンプトに追加し、エージェントが`read`ツールを使ってSKILL.mdの内容を読み取れるようにします [5](#0-4) 。

### スキルのロード場所

スキルは以下の場所からロードされ（優先度順） [6](#0-5) ：

1. `<workspace>/skills` - ワークスペーススキル
2. `<workspace>/.agents/skills` - プロジェクトエージェントスキル
3. `~/.agents/skills` - 個人エージェントスキル
4. `~/.openclaw/skills` - 管理済み/ローカルスキル
5. バンドルされたスキル（インストールに同梱）
6. `skills.load.extraDirs` - 追加スキルフォルダ

### pi-agent-coreとの連携

pi-agent-coreは以下を提供し、OpenClawがスキルシステムを構築する基盤となります [7](#0-6) ：

- **pi-ai**: LLM抽象化、メッセージタイプ、プロバイダーAPI
- **pi-agent-core**: エージェントループ、ツール実行、AgentMessageタイプ
- **pi-coding-agent**: 高レベルSDK（createAgentSession、SessionManagerなど）

OpenClawは`runEmbeddedPiAgent`を通じてpiセッションを作成し、カスタムツール注入、システムプロンプトのカスタマイズ、セッション永続化などの機能を追加しています [8](#0-7) 。

## Notes

pi-agent-core自体にはスキル機能がありませんが、OpenClawはシステムプロンプトの動的構築とSKILL.mdファイルの注入によって、エージェントにドメイン固有の知識と手順を教えるスキルシステムを実現しています [9](#0-8) 。

Wiki pages you might want to explore:
- [Overview (openclaw/openclaw)](/wiki/openclaw/openclaw#1)

### Citations

**File:** docs/pi.md (L9-38)
```markdown
OpenClaw integrates with [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) and its sibling packages (`pi-ai`, `pi-agent-core`, `pi-tui`) to power its AI agent capabilities.

## Overview

OpenClaw uses the pi SDK to embed an AI coding agent into its messaging gateway architecture. Instead of spawning pi as a subprocess or using RPC mode, OpenClaw directly imports and instantiates pi's `AgentSession` via `createAgentSession()`. This embedded approach provides:

- Full control over session lifecycle and event handling
- Custom tool injection (messaging, sandbox, channel-specific actions)
- System prompt customization per channel/context
- Session persistence with branching/compaction support
- Multi-account auth profile rotation with failover
- Provider-agnostic model switching

## Package dependencies

```json
{
  "@mariozechner/pi-agent-core": "0.73.0",
  "@mariozechner/pi-ai": "0.73.0",
  "@mariozechner/pi-coding-agent": "0.73.0",
  "@mariozechner/pi-tui": "0.73.0"
}
```

| Package           | Purpose                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `pi-ai`           | Core LLM abstractions: `Model`, `streamSimple`, message types, provider APIs                           |
| `pi-agent-core`   | Agent loop, tool execution, `AgentMessage` types                                                       |
| `pi-coding-agent` | High-level SDK: `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry`, built-in tools |
| `pi-tui`          | Terminal UI components (used in OpenClaw's local TUI mode)                                             |
```

**File:** docs/concepts/agent.md (L57-75)
```markdown
## Skills

OpenClaw loads skills from these locations (highest precedence first):

- Workspace: `<workspace>/skills`
- Project agent skills: `<workspace>/.agents/skills`
- Personal agent skills: `~/.agents/skills`
- Managed/local: `~/.openclaw/skills`
- Bundled (shipped with the install)
- Extra skill folders: `skills.load.extraDirs`

Skills can be gated by config/env (see `skills` in [Gateway configuration](/gateway/configuration)).

## Runtime boundaries

The embedded agent runtime is built on the Pi agent core (models, tools, and
prompt pipeline). Session management, discovery, tool wiring, and channel
delivery are OpenClaw-owned layers on top of that core.

```

**File:** docs/tools/skills.md (L11-16)
```markdown
OpenClaw uses **[AgentSkills](https://agentskills.io)-compatible** skill
folders to teach the agent how to use tools. Each skill is a directory
containing a `SKILL.md` with YAML frontmatter and instructions. OpenClaw
loads bundled skills plus optional local overrides, and filters them at
load time based on environment, config, and binary presence.

```

**File:** docs/tools/skills.md (L17-30)
```markdown
## Locations and precedence

OpenClaw loads skills from these sources, **highest precedence first**:

| #   | Source                | Path                             |
| --- | --------------------- | -------------------------------- |
| 1   | Workspace skills      | `<workspace>/skills`             |
| 2   | Project agent skills  | `<workspace>/.agents/skills`     |
| 3   | Personal agent skills | `~/.agents/skills`               |
| 4   | Managed/local skills  | `~/.openclaw/skills`             |
| 5   | Bundled skills        | shipped with the install         |
| 6   | Extra skill folders   | `skills.load.extraDirs` (config) |

If a skill name conflicts, the highest source wins.
```

**File:** docs/concepts/system-prompt.md (L212-238)
```markdown
## Skills

When eligible skills exist, OpenClaw injects a compact **available skills list**
(`formatSkillsForPrompt`) that includes the **file path** for each skill. The
prompt instructs the model to use `read` to load the SKILL.md at the listed
location (workspace, managed, or bundled). If no skills are eligible, the
Skills section is omitted.

Eligibility includes skill metadata gates, runtime environment/config checks,
and the effective agent skill allowlist when `agents.defaults.skills` or
`agents.list[].skills` is configured.

Plugin-bundled skills are eligible only when their owning plugin is enabled.
This lets tool plugins expose deeper operating guides without embedding all of
that guidance directly in every tool description.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

This keeps the base prompt small while still enabling targeted skill usage.
```

**File:** docs/tools/index.md (L28-36)
```markdown
  <Step title="Skills teach the agent when and how">
    A skill is a markdown file (`SKILL.md`) injected into the system prompt.
    Skills give the agent context, constraints, and step-by-step guidance for
    using tools effectively. Skills live in your workspace, in shared folders,
    or ship inside plugins.

    [Skills reference](/tools/skills) | [Creating skills](/tools/creating-skills)

  </Step>
```
