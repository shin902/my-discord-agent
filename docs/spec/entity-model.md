# エンティティモデル

> 参考: `docs/clone/nanoclaw/src/types.ts`
> nanoclaw は多対多だが、本プロジェクトは1グループ対多チャンネルのシンプルな1対多

```
AgentGroup（エージェント設定プロファイル）
  id, name, folder
  ← config/groups.json groups[]  (AgentConfigの既定値、group限定の配送・観測設定)
  ← groups/<folder>/AGENTS.md (グループ固有の指示・メモリ)
  │
  ├── [1対多] Channel（Discordチャンネル / DM）
  │     sessionMode
  │     │
  │     └── Session（sessionId = message.channelId → 通常会話の履歴）
  │           ※ スレッドは Discord 上で独自の channelId を持つため自然に分離される
  │
  └── [1対多] Bot（persistent role / config / capabilities）
        │
        └── [1対多] Task Session（仕事単位のsession trajectory）
              ※ delivery先のchannel/threadとは別のsessionIdを持つ
```

## 各エンティティの責務

| エンティティ | 責務 |
|---|---|
| `AgentGroup` | エージェントのAgentConfig既定値（モデル・ツール・スキル・mounts）とcontext/trust境界。複数チャンネルを持つ |
| `Channel` | Discordチャンネル1つ。必ず1つのグループに属し、AgentConfigを任意でoverrideできる。`sessionMode`（`shared` / `thread` / `auto-thread`）を持つ |
| `Session` | group内の1履歴。identityは `(agent_id,id)`、entryは `(agent_id,session_id)` の複合FK。`sessions.agent_id` が不変のowner（Bot未指定の通常会話は予約ID `main`、channelにBotを指定した通常会話とBot TaskはBot ID）。通常会話のsessionIdはmessage.channelId。スレッドは独自のchannelIdを持つ |
| `Bot` | AgentGroupに所属する永続的なrole / config / capability。Bot単位で会話履歴を共有しない |
| `Task Session` | BotのPR・Issue・調査テーマなど1仕事のworking context。handleで明示resumeし、delivery先とは分離する。初回snapshot保存時にBot ownerを固定する |

ownerはgroup DBのsession identityに属し、別groupや別ownerのtrajectoryを混ぜない。Bot registryの`main` IDは予約済みで使用不可。`bot_task_sessions`はresume/list/admissionの管理情報でありownerの正本ではない。v5→v6 DBの停止・バックアップ・手動変換と再起動の順序は[storage](../storage.md#session-trajectory)を参照。

## AgentGroupとBotのauthority境界

`AgentGroup` はtrust / authority ceiling（信頼・権限の上限）であり、`Bot` はそのdomain内でrole・context・capabilityを分割するpersistent workerである。Bot個体自体はsecurity boundaryではない。

- AgentがBotを呼ぶには、effective `tools` に `bot` を明示的に許可する必要がある。許可されていないrunにはBot呼び出しendpointやcapabilityを公開しない。
- 同じgroupの範囲内なら、Botがcallerと異なる、またはcallerより多いtools・skills・mountsを持っていても、それだけで権限昇格とはみなさない。`bot` の許可が任意のgroupや権限へのアクセスを意味するわけではない。
- `Subagent` はeffective `tools` に正確な `subagent` を明示的に許可したrunだけが利用できる。callerのeffective authorityを上限とするephemeral delegationであり、Botとは権限モデルが異なる。許可されていないrunにはsubagentのschemaやcapabilityを公開しない。
- 別group、host操作、高いtrust classやgroupで未許可のcapabilityへの移行は、通常のBot delegationではなく別のapproval / authorization boundaryで扱う。

現在、AgentGroupのceilingがBot profileのtools・skills・mounts等により機械的に証明されるわけではなく、同一group内の設定を運用者が管理する。public利用、複数ユーザー、外部入力起点のdelegationでは、group-level declaration、起動時validation、tool proxy policyなど、より強い検証を追加する必要がある。
