# グループのファイルシステム構造

> 参考: `docs/clone/nanoclaw/src/group-init.ts`
> 参考: `docs/clone/nanoclaw/src/container-config.ts`

```
groups/
  <folder>/
    CLAUDE.local.md    # グループ固有の指示・メモリ
    group.json     # MCP・マウント・ツール・モデル設定
```

## `group.json` の例

```json
{
  "model": "kimi-k2.6",
  "mcpServers": [
    { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"] }
  ],
  "additionalMounts": ["/path/to/project"],
  "allowedTools": ["filesystem", "web_search"]
}
```
