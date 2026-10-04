# 設定ファイルリファレンス

## 概要

設定は役割ごとに `config/` 配下の複数ファイルに分かれている。各ファイルは対応する `*.example.json` をコピーして作成し、環境に合わせて編集する。

```
config/
  config.json              # Discord application・defaultModel・proxy・agent などの設定
  config.example.json
  bots.json                # Agent Bot profile Registry（省略可）
  bots.example.json
  providers.json           # AI プロバイダーごとの実行ポリシー（省略可）
  providers.example.json
  credentials.json         # AI プロバイダー・外部サービスの接続設定
  credentials.example.json
  groups.json              # チャンネル→グループのマッピング＋エージェント設定
  groups.example.json
  cron.json                # 定期実行ジョブ定義（省略可）
  cron.example.json

groups/{name}/
  AGENTS.md                # グループのシステムプロンプト
```

AgentConfig（`model` / `tools` / `toolSets` / `approvalRequiredTools` / `skills` / `mounts` / `contextFiles` / `agentMemory`）は、コンテナにマウントされない静的設定として管理する。通常のDiscord会話では `group → Bot profile（指定時） → channel`、cronでは配送先のchannel/thread設定を継承せず `group → Bot profile（botId指定時） → cron job` の順で解決する。`groups/{name}/` はコンテナに書き込み可能な領域としてマウントされるため、エージェント自身が設定を書き換えられないようにする。`agentMemory.enabled` はGroup / Bot profile限定のオプトイン設定で、MainはGroup、Botは未指定ならGroupを継承し、明示booleanで上書きする（Channel / cron job overrideはない）。`allowMention` と `toolLogArgs` はgroup限定の配送・観測設定であり、channel/cronからはoverrideできない。

| ファイル | 必須 | トップレベル形式 | 内容 |
|---|---|---|---|
| `config/providers.json` | — | 配列（省略時は全 provider が `serial`） | AI プロバイダーごとの同時実行ポリシー |
| `config/credentials.json` | ✓ | 配列 | AI プロバイダー・外部サービスの接続設定 |
| `config/groups.json` | ✓ | 配列 | チャンネル → グループのマッピング |
| `config/cron.json` | — | 配列（省略時は空扱い） | 定期実行ジョブ定義・Memory export backend設定 |
| `config/config.json` | ✓ | オブジェクト | Discord application・`defaultModel`（必須）・proxy・agent設定 |
| `config/bots.json` | — | オブジェクト | Agent Bot profile Registry（省略時は空） |

> **`opencode-go` の `kimi-k2.6` は非推奨**: 大規模なツールコールで API エラーが頻発する問題が `pi-agent-core` の更新でも解消せず、他モデル（deepseek-v4 等）でも同様の報告がある（#107）。`zai-custom` の `glm-4.7-flash` は無料枠（並列実行1まで・コンテキスト制限なし）で安定して動く。プロバイダー同時実行のデフォルトは `serial` のため、`zai-custom` は追加設定なしでも安全に利用できる。

## config/cron.json の Memory export

Memory backendごとに `handler: "jobs/memory-export.ts"` を持つjobを定義し、接続先や対象groupを `settings` に置きます。cronはenqueueのみを行い、既存runtime queueがcanonical session trajectoryからのbounded export batchを処理します。設定・成功ledger・failure semantics・旧経路からのrolloutは [Agent Memory export](agent-memory.md) を参照してください。[cron example](../config/cron.example.json) はdisabledです。設定変更はrestartで反映し、queue jobは新processのstartup cacheを正とします。

### MemoryCore sidecarの起動

`compose.memory-core.yaml`はMemoryCore単体を公式imageから起動します。TencentDB Agent Memoryのstable release `v2.0.1`（2026-08-25）に含まれる`/v3/memory-prompt/*`契約をcustom prompt provisioningの根拠とし、そのAPIとの互換性をsmoke確認した公式MemoryCore image `agentmemory/memory-core:1.0.1`をmanifest digestまで固定しています。開発branchや独自forkには依存しません。Memory Hub / Memory ProxyやTencentDB repositoryのclone、自前buildは不要です。ホストのCLIProxyAPIが`127.0.0.1:8317`で待ち受けるため、MemoryCoreはhost networkで起動します。MemoryCore自身のGatewayは`127.0.0.1`にbindし、ホスト外部へ公開しません。MemoryCoreのデータはDocker volume `memory-core-data`へ永続化されます。

exampleをGit管理外の実設定へコピーします。`llm.baseUrl` / `llm.model` / `llm.maxTokens` / `llm.timeoutMs` は`config/memory-core.yaml`だけを編集します。Composeは`.env`の`MEMORY_CORE_LLM_API_KEY`を`TDAI_LLM_API_KEY`へ渡します。API key自体は追跡対象外のYAMLへ書きません。

ホスト上のCLIProxyAPIを使う場合は、`config/memory-core.yaml`の`llm.baseUrl`を`http://127.0.0.1:8317/v1`へ変更します。`network_mode: host`によりMemoryCore内の`127.0.0.1`はホストのCLIProxyAPIを指します。CLIProxyAPIにはMemoryCore専用のAPI keyを追加し、その同じ値を`.env`の`MEMORY_CORE_LLM_API_KEY`へ設定してください。既存の`CLIPROXY_API_KEY`を流用する必要はありません。`llm.model`にはCLIProxyAPIが提供する任意のmodel IDを設定してください（`/v1/models`で確認できます）。詳細は[CLIProxyAPIのAPI key設定](guides/codex-oauth-cliproxyapi.md#configyaml-の設定)を参照してください。

```bash
cp config/memory-core.example.yaml config/memory-core.yaml
```

`.env`にはAPI keyだけを書きます。

```env
MEMORY_CORE_LLM_API_KEY=<provider-api-key>
```

直接providerを使う場合の`config/memory-core.yaml`:

```yaml
llm:
  baseUrl: "https://api.openai.com/v1"
  model: "gpt-4o-mini"
```

CLIProxyAPIを使う場合は`llm.baseUrl`を`http://127.0.0.1:8317/v1`へ変更し、`llm.model`へCLIProxyAPIが提供する任意のmodel IDを設定します。

```env
MEMORY_CORE_LLM_API_KEY=<memory-core-dedicated-key>
```

```yaml
llm:
  baseUrl: "http://127.0.0.1:8317/v1"
  model: "<cliproxy-model-id>"
```

CLIProxyAPI側の`api-keys`へ`<memory-core-dedicated-key>`を追加します。既存の`CLIPROXY_API_KEY`とは分けて管理します。

exampleの`memory.pipeline.enableWarmup: true`では、`everyNConversations: 5`でも抽出thresholdが`1 → 2 → 4 → 5`と増えるため、最初の会話後から抽出が始まり得ます。厳密な5会話ごとのbatchではありません。また、my-discord-agentはcanonical trajectoryからL0へexportするだけなので、exampleの`memory.recall.enabled`は`false`です。

起動してhealth endpointを確認します。

```bash
pnpm memory-core up -d
memory_core_port="${MEMORY_CORE_PORT:-$(awk -F= '$1 == "MEMORY_CORE_PORT" { print $2; exit }' .env 2>/dev/null)}"
curl "http://127.0.0.1:${memory_core_port:-8420}/health"

# 運用コマンド
pnpm memory-core ps
pnpm memory-core logs -f memory-core
pnpm memory-core down
```

`MEMORY_CORE_GATEWAY_API_KEY`を`.env`へ設定するとGateway共有鍵認証が有効になります。Memory export cron jobの`settings.bearerTokenEnv`へ同じ環境変数名を指定してください。API keyの値自体はJSONへ書きません。prompt provisioningもこのcron jobの接続・scope設定を読み、secretだけを`bearerTokenEnv`が示す環境変数から取得します。v3 data-planeは共有鍵認証を無効にしてもBearer形式のヘッダーが必要です。`MEMORY_CORE_PORT`を変更する場合、上記health commandはシェル環境変数を優先し、未設定なら`.env`の値を読み取ります。Composeが使うGateway portと`settings.baseUrl`のポートは同じ値に合わせてください。

Composeは`config/memory-core.yaml`を読み取り専用でマウントします。設定項目の雛形は [`config/memory-core.example.yaml`](../config/memory-core.example.yaml) にあります。image tagはデータ形式のmigration notesを確認してから明示的に更新し、`latest`へは変更しないでください。volumeを削除する`down -v`は保存済みmemoryを消すため、通常の停止には使わないでください。

## config/providers.json

AI プロバイダーごとの同時実行ポリシー。ファイルを省略した場合や provider のエントリがない場合は、安全側の `serial` を使う。有限の並列数は正の整数、無制限の並列実行は `parallel` で指定する。起動時に検証・固定するため、変更の反映にはhostの再起動が必要。

```json
[
  { "provider": "zai-custom", "concurrency": "serial" },
  { "provider": "openai-codex", "concurrency": "parallel" },
  {
    "provider": "llama-cpp",
    "resource": "local-gpu",
    "concurrency": "serial"
  },
  { "provider": "halogen", "resource": "halogen-backend", "concurrency": 8 },
  { "provider": "halogen-vision", "resource": "halogen-backend", "concurrency": 8 }
]
```

- `resource`: 任意の推論リソース名。省略時はprovider専用のリソースを使う
- `serial`: 同じproviderの実行をFIFOで1件ずつ処理する。数値の `1` と同義
- 正の安全な整数（例: `8`）: 同じprovider内で最大N枠。満杯ならFIFOで待機し、待機中のabortでは実行しない
- `parallel`: 同じprovider内の実行数は無制限。ただし、同じresourceを使う別providerとは同時に実行しない

同じGPUや推論backendを共有するproviderには、両方のentryで同じ`resource`を明示する。resourceを使用できるのは一度に1つのproviderで、それぞれ異なる`concurrency`を指定できる。使用中のproviderは自身の上限まで追加実行でき、別providerが待っていても新しい要求を受け付ける。使用中providerの実行とロック待機要求がすべてなくなると、最も古い未キャンセル要求を持つproviderへ交代する。待機要求は共通のresource制御に登録済みのものだけを指し、DB上の未実行jobやsession順序待ちは含まない。要求が途切れないproviderはresourceを使い続けるため、別providerの待ち時間に上限はない。

`resource`を省略したproviderは専用のlock keyを使い、同名の明示resourceとは共有しない。codex・claude-code・他APIなど、異なるresourceを使うprovider同士は並列に実行できる。同じセッションのメッセージはこの設定とは別に、`runtime.sqlite`の順序制御で未完了の先行jobを追い越さないよう処理される。Bot Task Sessionの同期実行も同じDBのadmission ledgerを使う。詳細は[キューの状態と順序](inbox-queue.md#状態と順序)を参照。

制御は単一hostプロセス内で共有する。通常Agentは`sendMessage()`の実行全体で1枠を保持し、Web検索などのtool待機中も枠を返さない。Screen CaptureのVLM要約は画像ごとに同じ制御で1枠を取得する。同じproviderの通常Agent・Bot・VLMは同じ上限を共有し、別providerが同じresourceを使う場合は交代で実行する。後段のMemory Agentも通常queue経由でこの制御に従う。backendへのHTTPリクエスト数を直接計測・制限する機能や、複数hostをまたぐ分散制限ではない。

同期Botが親と同じresource・providerを使う場合は親の1枠を借りる。同じ親の枠を借りる子Botは1件ずつ実行し、別の親の子Botとは並列実行できる。親終了時は借用中の子をabortし、子の実行終了を待ってから親の枠を解放する。resourceを保持する親から別providerまたは別resourceの取得を必要とする同期呼び出し、および同じresourceのBot Task Sessionに先行処理がある同期呼び出しは、循環待ちを避けるため待機せず拒否する。明示resourceを持つ`parallel`もこの制約に従う。resource未指定の`parallel`は排他待ちがないため、通常どおり呼び出せる。

## config/credentials.json

AI プロバイダーや外部サービス（Microsoft Graph・Google Calendar・Tavily・GitHub 等）の接続設定。トップレベルは配列。
Reddit の Cookie 認証は `config/credentials.json` では管理せず、Tool Runtime の private state として扱います。詳細は [`docs/guides/reddit-cookie-setup.md`](guides/reddit-cookie-setup.md) を参照してください。
フィールドと認証値の選択規則の正本は [Credential設定リファレンス](config/credential-proxy.md)、認証境界は [proxy.md](proxy.md) を参照。

```json
[
  {
    "provider": "zai-custom",
    "api": "openai-completions",
    "envVars": ["ZAI_API_KEY"],
    "baseUrl": "https://api.z.ai/api/coding/paas/v4"
  },
  {
    "provider": "anthropic",
    "envVars": ["ANTHROPIC_API_KEY"],
    "baseUrl": "https://api.anthropic.com"
  },
  {
    "provider": "openai-codex",
    "envVars": ["CLIPROXY_API_KEY"],
    "baseUrl": "http://localhost:8317/v1",
    "api": "openai-responses"
  },
  {
    "provider": "llama-cpp-qwen3",
    "baseUrl": "http://localhost:8080/v1",
    "api": "openai-completions",
    "compat": { "thinkingFormat": "qwen-chat-template" }
  }
]
```

API キーなどの機密情報は `.env` に記載し、`envVars` で参照する。独自モデルには組み込みproviderと異なる名前を使う。Codex経路はmodel identityを`openai-codex`のまま保ち、wire APIだけを`openai-responses`へ変更してCLIProxyAPIへ接続する。詳しい構成は [Codex OAuth / CLIProxyAPIガイド](guides/codex-oauth-cliproxyapi.md) を参照。

## config/groups.json

チャンネル ID とグループ名・セッションモードのマッピングに加えて、グループごとのエージェント設定（モデル・ツール・allowMention 等）。トップレベルは配列。

```json
[
  {
    "name": "chat",
    "model": { "provider": "zai-custom", "modelId": "glm-4.7-flash" },
    "tools": ["bash", "tavily-search", "bot"],
    "skills": ["agent-reach"],
    "toolSets": ["agent-reach"],
    "allowMention": false,
    "toolLogArgs": true,
    "channels": [
      { "channelId": "111", "sessionMode": "shared" },
      {
        "channelId": "222",
        "sessionMode": "shared",
        "requiredMention": true,
        "tools": ["read"],
        "skills": [],
        "toolSets": [],
        "mounts": []
      }
    ]
  },
  {
    "name": "thread",
    "model": { "provider": "zai-custom", "modelId": "glm-4.7-flash" },
    "tools": ["bash", "read", "write", "edit"],
    "skills": ["agent-reach", "session-logs"],
    "toolSets": ["agent-reach"],
    "allowMention": true,
    "toolLogArgs": true,
    "channels": [
      { "channelId": "222", "sessionMode": "thread" },
      { "channelId": "333", "sessionMode": "auto-thread" }
    ]
  }
]
```

`config/groups.example.json` のchannel例で `approvalRequiredTools: []` を指定しているのは、groupから継承したapproval対象を解除し、channelの `tools: ["read"]` との不整合を避けるためです。

| キー | 必須 | 内容 |
|---|---|---|
| `name` | ✓ | `groups/{name}/` ディレクトリ名と対応 |
| `channels` | ✓ | チャンネル ID とセッションモードのマッピング |
| `botId` | — | channel限定。親チャンネルに割り当てるAgent Bot profile ID（`config/bots.json`）。子スレッドも継承し、未指定はMain。Discord接続identityのgroup `bot` とは別 |
| `appendUserOnly` | — | channel限定の任意boolean。`true` はshared channelのlive human messageをuser entryとして保存し、Agent実行・応答しない。未指定 / `false` は通常挙動。詳細は [チャンネルモード](spec/channel-modes.md#appenduseronly) |
| `requiredMention` | — | チャンネル単位で指定できる任意の boolean。`appendUserOnly` 無効時に `true` の場合はBotへのメンションを含む通常メッセージだけを処理し、省略時（既定）は制限しない。親チャンネルのポリシーは子スレッドにも適用され、スラッシュコマンドは対象外 |
| `model` | — | AgentConfig。`provider`/`modelId`/`thinkingLevel`。`thinkingLevel`は`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`を許容し、各値の意味とwire mappingはPiのmodel metadataへ委譲する。channelで指定するとgroupのmodelオブジェクトを完全置換 |
| `tools` | — | AgentConfig。エージェントに渡す MCP ツール名の配列。`bot` と `subagent` は正確な名前を明示した場合だけ有効なcontext-created tool。channelで指定するとgroupの配列を完全置換するため、groupで許可したtoolもchannel側で指定しなければ無効 |
| `approvalRequiredTools` | — | AgentConfig。effective native `tools` とeffective `toolSets` の和集合に含まれる既知host/runtime capabilityのうち、承認を挟むtool名だけを指定する。全layerで未指定のためeffective configに設定がない場合、またはeffective `[]` の場合は従来どおり承認なし。子layerで未指定なら親を継承し、`[]` は明示解除。未知名・許可集合外・sandbox内toolは設定エラー。`skills` はこのvalidationに関与しない。子layerで指定した配列は完全置換 |
| `allowMention` | — | 元メッセージへの reply 形式で送信し、返信先ユーザーに通知するか。省略時は返信するが通知しない |
| `toolLogArgs` | — | ツール実行ログに引数を含めるか |
| `skills` | — | AgentConfig。`groups/{name}/SKILLS/` から説明・workflowを公開するスキル名の配列、または文字列 `"*"`（配置済みSkillをすべて公開）。`["*"]` は無効。group設定では起動時にエラーとなり、channel / Bot profile設定ではその設定が実行時に適用される際にエラーとなる。capabilityは付与しない。親を継承後も未指定、または `[]` ならスキルなし。channelで指定するとgroupの指定を完全置換 |
| `toolSets` | — | AgentConfig。trusted capability bundle名の配列。`agent-reach` / `arxiv-search` / `arxiv-survey` / `last30days` / `web` / `github` / `mail` / `calendar` / `weather`。native `tools` のhost/runtime capabilityとの和集合をrun authorityにする。Skill説明やnative schemaは追加しない。未指定なら親を継承、`[]` はbundle許可を解除、指定配列は完全置換。未知名と `"*"` は設定エラー |
| `mounts` | — | AgentConfig。コンテナへの追加マウント設定。channelで指定するとgroupのmountsを完全置換 |
| `agentMemory` | — | Group / Bot profile限定。`{ "enabled": true }` で有効化。未指定のGroupは無効、未指定のBotはGroupを継承。明示した `enabled` はboolean必須。Channel / cron jobでは指定不可。詳細は [Agent Memory](agent-memory.md#owner別markdownと新規sessionの初回選択) |
| `contextFiles` | — | AgentConfig。workspace相対ファイルを配列順にsession初回のuser roleへ注入する。各要素は `{ "path": string, "maxChars": 正の整数 | "*" }`。`"*"` は無制限。absolute pathと`..`は禁止し、不存在ファイルは無視する。子layerの配列は完全置換し、`[]`で無効化 |

有効な追加mountがある場合、Agentのsystem contextにはcontainer側pathと読み書き権限（`ro` / `rw`）を列挙し、既存mountの直接利用を促す。host側pathは表示しない。mount未設定時はこの案内を追加せず、作業ディレクトリは引き続き `/workspace` とする。

`sessionMode` の正本は [チャンネルモード](spec/channel-modes.md) を参照。通常のDiscord会話におけるAgentConfigの解決順は `group → Bot profile（指定時） → channel`、cron jobにおける解決順は `group → Bot profile（botId指定時） → cron job` である。`approvalRequiredTools` は他のAgentConfig配列と同様にfield単位で完全置換され、子layerで未指定なら親を継承し、`[]` は明示解除となる。既存mutation capabilityを自動的に必須化しない。cronの `channelId` は配送先を指定するためだけに使われ、通常チャンネルIDでも既存スレッドIDでもchannelのAgentConfigは継承しない。未指定フィールドは親を継承し、指定フィールドはモデルオブジェクトや配列を含めて完全置換する。`tools` / `toolSets` / `approvalRequiredTools` / `skills` / `mounts` / `contextFiles` の暗黙加算やdeep mergeは行わない。したがって、groupやcron jobで `subagent` を許可していても、channelやcron jobが `tools` を完全置換してその名前を含めなければ、実行時にsubagent toolは公開されない。`allowMention` / `toolLogArgs` はgroup限定で、AgentConfigには含まれない。

### 起動時Discord履歴バックフィル

`appendUserOnly: true` を除く設定済みチャンネルで、ボット停止中にDiscordへ届いたメッセージを起動時にDiscord APIから取得し、`MessageCreate` と同じ取り込み処理を通して通常のinboxへ投入する。`appendUserOnly` の有効期間は回収せず、normal復帰時には現在tipから再開する（[cursorの扱い](spec/channel-modes.md#appenduseronly)）。

初回起動時は現在の最新メッセージをカーソルとして登録するため、既存履歴を遡らない。以降は `data/runtime.sqlite` の `discord_sync_cursors` に保存したカーソルより後を取得する。既存スレッドの復旧ではアーカイブ済みスレッドも対象に含める。

ライブ受信とバックフィルの両方でDiscordメッセージIDを冪等キーに使うため、起動処理と通常イベントが競合しても二重投入されない。バックフィルではbot/Webhookメッセージを対象外とし、過去RSSの再処理は行わない。

`shared` は親チャンネル、`thread` は既存スレッド、`auto-thread` は親メッセージごとのスレッド作成・再利用を対象にする。スレッド作成にはDiscord側のスレッド作成権限、履歴取得にはメッセージ履歴の閲覧権限が必要。

`skills` と権限設定 `toolSets` は独立です。Skillの内容・存在・hashをauthority sourceにしません。旧Skill名からの暗黙grantは削除したため、既存の `agent-reach` / `arxiv-search` / `arxiv-survey` / `last30days` Skillには同名の `toolSets` を明示してください。`web` は複数のWeb系capabilityをまとめて許可するumbrellaです。bundle内容とdescribe操作は [Tool Runtime仕様](spec/tool-runtime.md#runの権限と提示) を参照してください。

`skills` はキー自体を省略するか `[]` を指定するとスキルをロードしません。個別選択はスキル名の配列、全選択は文字列 `"*"` で指定します。たとえば次の設定では、`groups/chat/SKILLS/` に配置済みのSkillをすべて公開します。ワイルドカードはテンプレートをgroupへコピーしません。

```json
{
  "name": "chat",
  "skills": "*"
}
```

`skills: ["*"]` は無効です。配列要素はSkill名として検証され、`*` は許可された名前形式ではありません。group設定では起動時に `不正なスキル名` エラーとなり、channelまたはBot profileのoverrideでは、その有効設定がAgent実行に適用される時点で同じエラーになります。cron overrideではenqueue時の設定検証でエラーになります。`skills: "*"` 形式でもcapabilityは付与されません。

## groups/{name}/AGENTS.md

グループのシステムプロンプト。新しいグループフォルダが存在しない場合、`ensureGroupDirs`（`src/config/group-config.ts`）が起動時に `templates/group/AGENTS.md` を `groups/{name}/AGENTS.md` としてコピーして作成する。

- `templates/group/AGENTS.md` は `You are a helpful Discord assistant.` のみを初期値としてコピーする。グループ固有の役割説明・ルール・出力フォーマット等はコピー後に各グループの `AGENTS.md` へ追記する
- AGENTS.md を置くと組み込みのデフォルトシステムプロンプトは完全に置き換えられる。テンプレートは新規グループ用の初期値であり、既存の `groups/{name}/AGENTS.md` は上書きされない
- 利用可能なツール一覧は API 経由で自動注入されるため、テンプレートやグループ側の AGENTS.md にツール名を列挙しない（`config/groups.json` の変更やツール改名で内容が嘘になるため）。書くのは「どう振る舞うか」だけにする

## config/cron.json

cronの `historyMode` は過去の履歴の引き継ぎ方を指定します。`full` は配信先sessionを継続してfull historyを使い、`final-only` は同じsession IDで過去公開finalだけを継続contextへ渡します。`fresh` は実行ごとに新しいsessionを使います。queueに保存されたmodeを実行時に使用します。適用範囲・旧履歴の扱いは [cronのfinal-only historyMode](spec/cron.md#final-only-historymode) を参照してください。

定期実行ジョブの定義。トップレベルは配列。ファイル自体が存在しない場合も cron は空扱いで起動する（空配列の場合と同じ挙動）。
詳細は `docs/spec/cron.md` を参照。

```json
[
  {
    "id": "mail-check",
    "schedule": "*/30 * * * *",
    "enabled": true,
    "deliveryMode": "direct",
    "historyMode": "fresh",
    "handler": "jobs/mail.ts"
  },
  {
    "id": "cheap-daily-summary",
    "schedule": "0 9 * * *",
    "enabled": true,
    "groupName": "my-group",
    "prompt": "昨日の要点を短くまとめてください",
    "channelId": "YOUR_CHANNEL_ID",
    "deliveryMode": "direct",
    "historyMode": "fresh",
    "model": { "provider": "zai-custom", "modelId": "glm-4.7-flash" },
    "tools": ["read"],
    "skills": ["session-logs"]
  }
]
```

宣言的ジョブ（`handler` を使わず `groupName`/`prompt`/`channelId`/`deliveryMode`/`historyMode` を指定する形式）では、投稿方法と過去履歴の引き継ぎ方を別々に設定する。

| フィールド | 値 | 動作 |
|---|---|---|
| `botId` | string（任意） | 同じgroupに所属するAgent Bot profile ID。未指定はMain。指定時はhandlerでもgroupName必須。宣言型jobと `enqueueCronInbox()` を使うhandlerが対象 |
| `deliveryMode` | `direct` | `channelId` へ直接投稿する。通常チャンネルだけでなく既存スレッドのIDも指定可能 |
| `deliveryMode` | `new-thread` | `channelId` を親として実行ごとに新しいスレッドを作成する |
| `deliveryMode` | `item-thread` | 一時sessionでAIを実行し、応答がある場合だけ親メッセージを投稿してmessage/thread IDへsessionを昇格してから1項目用スレッドを作成する。`historyMode` は `full` または `final-only` 必須 |
| `historyMode` | `full` | 配信先sessionを継続してfull historyを使う。投稿先チャンネルまたはスレッドのIDをセッションIDにする |
| `historyMode` | `final-only` | `full` と同じsession IDを使い、過去公開finalだけを継続contextへ渡す |
| `historyMode` | `fresh` | cron実行ごとに新しいsessionを使い、過去runの履歴を引き継がない |
| `noReply` | `true` | このcronリクエストのsystem promptへ、通知不要時に独立行 `<NO_REPLY>` を返す指示を追加する。`item-thread`でも利用可能 |

独立行 `<NO_REPLY>` の応答は通常会話、および`direct`/`new-thread`/`item-thread` cronで正常完了し、Discordへ配送しない。inlineの言及は通常どおり配送する。`noReply`の既定値は`false`で、AGENTS.mdなどに同じ指示を書く場合は不要。`item-thread`はAI実行後までDiscord状態を作らないため、NO_REPLY時は親メッセージもthreadも作成しない。Mail/RSSは無配信時も処理済みとしてsourceを確定する。Mailの既読化に失敗した場合は未読のまま次回cronで再取得し、RSSの確定に失敗した場合はclaimを解放して次回cronで再取得する。`new-thread` + `full` は既存のsession ID契約を守るためAI実行前にスレッドを作るので、NO_REPLY時は投稿のないスレッドが残る。

既存スレッドへ投稿しつつ毎回セッションを分離する場合は、`channelId` にスレッドID、`deliveryMode` に `direct`、`historyMode` に `fresh` を指定する。`item-thread` は1項目ごとの独立スレッドを使うため `full` または `final-only` と組み合わせる。旧 `mode` も後方互換のため読み込めるが、新しい設定では使用しない。`to-channel` は `direct` + `fresh`、`to-thread` は `new-thread` + `full` として扱われる。

`model` / `tools` / `toolSets` / `approvalRequiredTools` / `skills` / `mounts` / `contextFiles` を任意で指定すると、`group → Bot profile（botId指定時） → cron job` の順でそのジョブの実行時設定を解決する。cronの `channelId` は配送先だけを表し、配送先channelまたは既存threadのAgentConfig・Bot指定は継承しない。`skills` はスキル名の配列、`[]`、または文字列 `"*"`（配置済みSkillすべて）を指定できる。指定フィールドは完全置換で、モデルオブジェクトや配列のdeep merge・暗黙加算は行わない。上書きは cron 実行から生成される inbox メッセージにだけ付与され、通常の人間の会話や `config/groups.json` 自体には影響しない。`handler` 付きジョブは従来どおり `settings` 経由でハンドラー側が自由に扱う。`allowMention` / `toolLogArgs` はgroup設定のみで、cron jobからは変更できない。

### jobs/mail.ts

`mail.ts` は未読メールごとに本文とACK対象のメールIDを取得し、Mail機能モジュールで決定論的な `mailRouteKey` を付けて共通cron enqueue経路へ投入する。GitHub通知は送信元が `notifications@github.com` で、`List-Id` からowner/repo、件名末尾 `(#number)` または `(PR #number)` からitem番号を取得できた場合だけ `github:<owner>/<repo>:item:<number>` にする。PRのCI失敗通知（`PR run failed:`）は件名末尾のコミットハッシュをGitHub APIで照会し、同じリポジトリの関連PRを一意に特定できれば同じitem routeにする。候補なし・複数候補・取得上限の場合は送信元routeへ戻す。APIエラー時はenqueueせず未読のまま次回の収集で再試行する。この照会には `github` providerと対象リポジトリへの読み取り権限が必要。本文中のURLはroutingに使わない。それ以外は表示名を除いた小文字のsender addressから `mail:<address>` を生成する。Mailは常に `direct` + `fresh` で要約sessionをメールごとに分離し、親Text Channelの下に送信元別Discord threadを作る。`channelId` には既存threadではなく親Text Channelを指定する（既存threadなら配送を失敗として扱う）。mappingはgroup・親channel・routeごとに分離し、thread名にはsender addressまたは `owner/repo #number` を使う。保存済みthreadが削除されていれば新規作成して更新する。全delivery chunkが`sent`になった後にだけメールを既読化し、既存のretry / dedupe semanticsは変更しない。

AI・delivery・既読化の失敗時はメールが未読のまま残る。次回cronは過去jobを復旧せず、そのメールに新しいjobを作るため、失敗した試行のDiscord投稿が残る場合は同じthread内で重複しうる。これはmailの既知の残余リスクとして扱い、RSS dispatchなど別目的の冪等性は維持する。

複数producerや複数ホストで同じメールソースを処理する協調は保証しない。

### jobs/rss-collect.ts / jobs/rss-dispatch.ts

RSS処理は収集とエージェント投入を分離する。`rss-collect.ts` はLLMを使わずRSS/Atomフィードの記事を `data/rss.sqlite3` に保存し、`rss-dispatch.ts` は未読記事をまとめて通常のエージェントinboxへ投入する。

対応形式をRSS 2.0とAtom 1.0へ絞る判断、公開フィード20件の実測結果、RSS 1.0 / RDFと非UTF-8の扱いは [RSSフィード形式の対応範囲調査](research/rss-format-support-audit.md) に記録している。以下は絞り込み前の現行実装について説明する。

```json
[
  {
    "id": "rss-collect",
    "schedule": "*/15 * * * *",
    "handler": "jobs/rss-collect.ts",
    "settings": {
      "feeds": ["https://example.com/feed.xml"],
      "bootstrap": "mark-seen"
    }
  },
  {
    "id": "rss-dispatch",
    "schedule": "5,20,35,50 * * * *",
    "groupName": "rss",
    "channelId": "YOUR_CHANNEL_ID",
    "prompt": "各記事のURLをagent-reachで取得し、日本語で要約してください",
    "deliveryMode": "direct",
    "historyMode": "fresh",
    "handler": "jobs/rss-dispatch.ts",
    "tools": ["bash"],
    "skills": ["web"],
    "toolSets": ["web"],
    "settings": {
      "feeds": ["https://example.com/feed.xml"],
      "maxItemsPerRun": 10,
      "maxSummaryChars": 4000
    }
  }
]
```

Collectorの`feeds`にはURL文字列、または `{ "name": "表示名", "url": "URL" }` を指定できる。ETagとLast-Modifiedが返るフィードでは条件付き取得を使用する。`bootstrap`の既定値は`mark-seen`で、初回に掲載されていた記事を既読として保存する。`process`にすると初回記事も未読で保存する。

Collectorが取得するRSS本文の上限は5 MiBで、現在は設定から変更できない。これはRSS/Atomとしての妥当性ではなく、取得先の誤設定や侵害による過大なメモリ消費を防ぐための運用上限である。`Content-Length`がない場合や実際より小さい場合も、本文を読みながら上限を検査し、超過した時点で取得を中断する。正当なフィードであっても5 MiBを超えるものは収集対象にできない。

記事数には上限を設けず、解析した全記事を1トランザクションでSQLiteへ保存する。

フィード形式の解釈には、RSS/RDF/Atomの正規化、`xml:base`を含む相対URL解決、Atom XHTML処理を備えた`feedparser`を使用する。文字コード判定は`encoding-sniffer`へ委譲し、BOM、XML宣言、HTTP `Content-Type`の`charset`を反映する。汎用XMLパーサー上でこれらのフィード仕様を独自に実装しない方針とし、UTF-16、Shift_JIS、HTTP charset、相対URL、階層的`xml:base`、Atom XHTMLを回帰テストで固定する。

選定時には`feedsmith`、`@rowanmanning/feed-parser`、`feedparser`を同じAtom入力で比較した。`feedsmith`は相対URLとXHTMLマークアップを保持したまま返し、`@rowanmanning/feed-parser`はXHTMLをテキスト化できるが最終レスポンスURLを解析時のベースURLとして渡せなかった。`feedparser`は`feedurl`オプションと階層的`xml:base`処理によって両方を満たすため採用した。ライブラリ自身はHTTP取得を行わず、Collectorが上限内で取得した本文だけを渡す。

Dispatcherは`maxItemsPerRun`件の未読記事を1つのinboxメッセージへまとめる。`prompt`は必須で、記事の取得方法や要約形式もここに指定する。inboxにはこの`prompt`と記事情報だけを渡す。

Dispatcherの`settings.feeds`にはCollectorと同じURL文字列、または`{ "name": "表示名", "url": "URL" }`を指定でき、指定したフィードの未読記事だけを処理する。省略時は後方互換のため全フィードを処理する。複数Dispatcherを使う場合は全ジョブで`feeds`を指定し、対象URLが重複しないようにする。全件Dispatcherとフィード指定Dispatcherを同時に有効化すると、cronの並列実行時に同じ未読記事を重複投入する可能性がある。

dispatchは未読記事をclaimしてqueueへ投入する。配送の全chunkが`sent`になった場合、または明示的な`<NO_REPLY>`成功で配送を抑制した場合にだけ既読へ確定する。Agent処理・配送の失敗（`failed` / `ambiguous`を含む）ではclaimを解放し、次回dispatchで再取得できる。起動時にも保存済みqueue結果とclaimを照合する。投入失敗時もclaimを解放する。

`maxSummaryChars`は記事ごとにinboxへ含めるRSS概要の最大文字数。`model`、`tools`、`skills`も通常の宣言的cronと同じようにエージェント実行へ引き継がれる。CollectorとDispatcherが同時実行にならないよう、設定例では5分ずらしている。

### jobs/issue-triage.ts

GitHub Issue を定期的に棚卸しし、`issue-triage` グループ（`tools: ["bash", "list-issues", "read-issue", "comment-issue"]`）に判断・コメント投稿まで一貫して行わせるハンドラー。

```json
{
  "id": "issue-triage",
  "schedule": "0 * * * *",
  "enabled": true,
  "groupName": "issue-triage",
  "channelId": "YOUR_CHANNEL_ID",
  "handler": "jobs/issue-triage.ts",
  "settings": {
    "owner": "YOUR_GITHUB_USERNAME",
    "repo": "YOUR_REPO_NAME",
    "allowedAuthors": ["YOUR_GITHUB_USERNAME"]
  }
}
```

- `settings.owner`/`settings.repo`: 対象リポジトリ
- `settings.allowedAuthors`: 処理対象とする Issue 投稿者の許可リスト（省略時は `owner` のみ）。第三者が投稿した Issue は処理対象から除外し、issue本文への攻撃文によるプロンプトインジェクションの影響範囲を限定する
- 各Issueは共通cron enqueue経路から、handler固定の `direct` + `fresh` で独立したAgent jobとして投入し、成功後にだけprocessed stateを保存する。`deliveryMode` / `historyMode` はこのhandlerでは設定しても反映されない。7日経過したfresh sessionはsession-cleanupの対象になる
- 重複コメント防止のため、処理済み Issue 番号と `updated_at` を `data/issue-triage/state.json` に記録し、値が変化していなければ再処理しない。同一プロセス内でジョブが並行実行されても読み書きが直列化されるため、別リポジトリを対象にした複数の issue-triage ジョブを同時に動かしても state が失われない
- エージェントがコードを根拠付けに参照できるよう、`issue-triage` グループには `config/groups.json` の `mounts` でコードを読み取り専用マウントする想定（`config/groups.example.json` 参照）
  - **`host: "."`（リポジトリルートそのもの）は絶対にマウントしないこと。** `.env`（`DISCORD_BOT_TOKEN` 等）や `config/credentials.json` は git管理外（`.gitignore`）だが実ファイルとして存在するため、読み取り専用でもエージェントの `bash` から閲覧でき、`comment-issue` で公開Issueにそのまま漏洩しうる
  - 必ず、これらの機密ファイルを含まない別の場所（git clone した別ディレクトリ等）を用意し、その絶対パスを `mounts.host` に指定する

## config/config.json

`groups.json` / `credentials.json` / `cron.json` に分離されていない残りの設定。トップレベルはオブジェクト。

### `discord`

Discord runtime は `discord.bots` map に定義した Bot を使用します。デフォルト identity `personal` も通常の entry として必須です。各 entry の `tokenEnv` はトークンを読む環境変数名（トークン値は設定ファイルへ書かない）、`applicationId` は非機密な Discord application ID です。`pnpm discord:deploy global` または `pnpm discord:deploy guild <guild-id>` は、同じ `src/discord/command-registry.ts` の command set を全 Bot application の選択 scope へ bulk overwrite します。deploy script は存在する `.env` を自動で読み込みます。

通常のDiscordテキスト配送では、URL文字列は変更せず、長文を分割した場合に限り最後のchunk以外へ `MessageFlags.SuppressEmbeds` を付けます。最後のchunk（分割されないメッセージを含む）はリンクカードを許可します。キュー配送、コマンドの受付メッセージ、cronのメッセージでもこの挙動を使います。

```json
{
  "discord": {
    "bots": {
      "personal": {
        "applicationId": "YOUR_PERSONAL_DISCORD_APPLICATION_ID",
        "tokenEnv": "DISCORD_BOT_TOKEN"
      },
      "public": {
        "applicationId": "YOUR_PUBLIC_DISCORD_APPLICATION_ID",
        "tokenEnv": "DISCORD_PUBLIC_BOT_TOKEN"
      }
    }
  }
}
```

各 Bot の `tokenEnv` で指定した環境変数を deploy と runtime の実行環境に設定してください。既存設定から移行する場合は、`DISCORD_APPLICATION_ID` を削除し、その値を `discord.bots.personal.applicationId` へ移し、`tokenEnv: "DISCORD_BOT_TOKEN"` の `personal` entry を追加します。deploy の scope 引数は省略できず、省略時は usage error になります。

| キー | 必須 | 内容 |
|---|---|---|
| `defaultModel` | ✓ | `groups[].model` 省略時に使うデフォルトモデル（`provider`/`modelId`） |
| `proxy` | — | `requestTimeoutMs`: クレデンシャルプロキシの upstream リクエストタイムアウト（ms、デフォルト: 120000） |
| `compaction` | — | 全Group / Bot / Channel / cron共通の圧縮設定。既定値は `{ "enabled": true, "threshold": 0.7, "keepRecentTokens": 20000 }`。`enabled: false` はautoだけを停止し、手動compactは利用可能。個別overrideは不可。詳細は [clear / compact](spec/session-context.md) |
| `agentMemory` | — | `threshold`: owner別Markdownの初回選択閾値（0〜1、仮の初期値0.7）。有効化はGroup / Bot profileの `agentMemory.enabled` で行い、このglobal設定では行わない。Host認証は `TYPESAFE_API_KEY`。詳細・制約は [Agent Memory](agent-memory.md#owner別markdownと新規sessionの初回選択) |
| `agent` | — | `timeoutMs`: エージェントプロセス（サンドボックスコンテナ）のタイムアウト（ms、デフォルト: 600000＝10分） |
| `xSavedReceiver` | — | `enabled`（既定: false）、`port`（既定: 8787、1–65535）。localhost 専用の X saved 受信サーバー。[Tailscale Serve と拡張の設定手順](x-saved.md#live-capture-setup)を参照。変更後は再起動が必要 |
| `screenCaptureReceiver` | — | `enabled`（既定: false）、`port`（既定: 8788、1–65535）。localhost専用の画面PNG receiver。[Mac / Tailscale / 要約の設定](screen-capture.md)を参照。変更後は再起動が必要 |
| `screenCaptureSummary` | — | `enabled`（既定: false）、`groupName`、任意のAgent設定、`settings`（mode / visionModel / limit / concurrency）。pending枚数で要約を起動。[詳細](screen-capture.md) |
| `screenCaptureDailySummary` | — | `enabled`（既定: false）、`groupName`、`startDate`、`prompt`、`channelId`、任意のAgent設定、`deliveryMode` / `historyMode`。撮影日の境界とbatch完了で日次レポートを起動。[詳細](screen-capture.md#日付境界による日次レポート) |
| `xSavedGallery` | — | `enabled`（既定: false）、`port`（既定: 8789、1–65535）。有効時はPOST元検証用の `origin`（HTTPS `.ts.net` origin、末尾 `/` なし）が必須。receiverとは別のlocalhost listener。Gallery自身の認証はなく、アクセス制限はTailscale側で行う。[Gallery設定・アクセス・編集](x-saved.md#gallery-browse-and-edit-over-tailscale)を参照。変更後は再起動が必要 |

Botのauthority modelと、`bot` capabilityを明示的に許可する理由は [エンティティモデルのauthority境界](spec/entity-model.md#agentgroupとbotのauthority境界) を参照。`bots` の `group` は Bot が所属する AgentGroup の trust/context boundary を指定する。通常のDiscord会話では `group → Bot profile（指定時） → 親channel` の順でAgentConfigを解決する。明示的なBot Task実行（Discordの `/bot` コマンド・agent-facing `bot` tool）では `group → Bot profile` の順で解決し、channel の設定は継承しない。Bot profile の effective `model` / `tools` / `mounts` は起動時に検証され、不正な設定があれば Discord client 初期化前に起動を停止する。Discordでは `/bot` コマンドに `bot` を指定し、`action`（`run` / `resume` / `list`）を選択できる。`run`（action省略時も同じ）は `prompt` で新しいTask Sessionを作成し、応答に表示された `session` handleを `resume` で明示指定すると同じ仕事を続行できる。手動の`run` / `resume`では、Interaction ACKとしてephemeral responseをdeferするが、成功時の受付情報としては残さない。受付成功時はBot ID、実際に渡したprompt、Task Session情報をephemeral responseとは独立した通常の永続メッセージとして投稿し、その後ephemeral ACKを削除する。validation / enqueue等の受付失敗時は、従来どおりephemeral responseへエラーを表示する。`list` は現在のAgentGroupとBotが所有するTask Sessionだけを表示し、応答はephemeralのままになる。Botの実行は通常のキュー・sandbox・Discord配送経路を利用するが、Task Sessionの履歴・添付領域は呼び出し元の通常channel/thread sessionから分離され、応答の配送先だけが呼び出しchannel/threadに残る。Bot Task内部のtool / Subagent progressは通常channelへ送信せず、error通知と最終応答は維持する。メインAgentには同じBot Registryを呼び出す組み込み `bot` toolが、effective `tools` に正確な名前 `bot` を明示した場合だけ提供され、`action=run|resume|list` を指定できる。Bot profileやqueued/direct Bot childの実行では再帰的な `bot` toolを常に無効化する。`run` / `resume` はキューへ積まず、同じtool call内でsandbox実行の完了まで待って結果を返す（非同期handle返却やpollingは行わない）。親の推論枠の借用とdeadlock防止は [provider concurrency設定](#configprovidersjson) に従う。Bot Task Sessionのqueued/direct実行はruntime.sqliteの同じordered jobs/direct-admission ledgerで直列化され、agent toolとDiscordの`/bot`が同じTask Sessionを同時にresumeしても履歴を同時更新しない。プロセス起動時は管理対象コンテナ（現行labelと旧形式の名前のものを含む）の停止を確認した後、前回プロセスの未完了admissionとqueue実行を回収する。Dockerのdiscoveryまたは停止確認に失敗した場合は起動を中止し、実行状態を回収しない。

## config/bots.json

Agent Bot profile の canonical source です。トップレベルに Bot ID をキーとする map を置きます。各 profile は所属する `group`、caller-facing の空でない `description`、Bot本人向けの空でない `instructions`、任意の AgentConfig（`model` / `tools` / `toolSets` / `approvalRequiredTools` / `skills` / `mounts` / `contextFiles` / `agentMemory`）を持ちます。`config/config.json` の `discord.bots` は Discord application の接続設定であり、Agent Bot profile とは別の設定です。両ファイルの `bots` はmergeされません。

```json
{
  "coding": {
    "group": "default",
    "description": "Implements and reviews code changes.",
    "instructions": "コード変更を担当する worker",
    "model": { "provider": "zai-custom", "modelId": "glm-4.7-flash" },
    "tools": ["read", "write", "edit"],
    "skills": [],
    "mounts": []
  }
}
```

`agentMemory` は省略するとGroupの設定を継承します。`"agentMemory": { "enabled": false }` でこのBotだけ無効にでき、`true` ならGroupの有効・無効にかかわらず有効になります。無効化後も既存snapshotの履歴再生は維持します。

`description` は呼び出し側AgentがBotの用途を判断するための短いmetadataです。前後の空白を除去し、未指定・空文字・空白のみは起動時に拒否します。既存の各Bot profileにも用途を明示して追加してください。Bot IDや `instructions` からの自動推測・補完は行いません。秘密情報やBot内部の設定を記載しないでください。

`bot` toolが有効な場合、現在のAgentGroupに所属する利用可能なBotの `id + description` をtool descriptionに常時含めます。

```text
Available bots:
- coding: Implements and reviews code changes.
```

Botがない場合は `(none)` と表示します。別groupのBot、`instructions` 全文、mounts、credentials、内部authorityやその他のprofile設定は公開しません。専用のdiscovery toolは追加せず、既存の `bot(action=run|resume|list)` を維持します。`list` はBot一覧ではなく、引き続き現在のgroup / Botが所有するTask Sessionを列挙します。Discord `/bot` のUXは変更しません。

catalogはtool surface構築時に現在ロード済みのRegistryから生成し、`description` もcatalog全体もTask Sessionのsystem prompt snapshotには保存しません。Registry / group設定のファイル変更は既存どおり再起動が必要で、再起動後のtool surfaceに反映されます。

`instructions` はTask Sessionのbase role promptであり、Main/groupのrole promptへの追記ではありません。Discord `/bot run`・agent-facing `bot run` の新規Task作成時に、queue/direct admissionより先にgeneric `system-prompt-snapshot` として `sessions.sqlite` へ固定します。profile変更後も同じTaskのresumeは保存済みinstructionsを使い、新規Taskだけが変更後のinstructionsを使います。`model` / `tools` / `toolSets` / `skills` / `mounts` はsnapshotせず、現在のAgentConfig解決を維持します。

legacy Taskの保存済みsnapshotはgroup/Main roleであっても書き換えず使用し、現在のBot instructionsも追記しません。snapshotがないTaskは実行を拒否します。新しいBot roleで実行するには新規runを使ってください。詳細は [Bot Task Sessionのrole source](spec/initial-context-injection.md#bot-task-sessionのrole-source) を参照してください。

Bot profile の effective AgentConfig と `group` は起動時に検証されます。未定義の group や不正な profile があれば Discord client 初期化前に起動を停止します。Botを使わない場合は `bots.json` を配置せず、空の Registry として起動できます。既存の `config/config.json` にトップレベル `bots` がある場合は、その map を `config/bots.json` へ移してから `config/config.json` から削除してください。`discord.bots` はDiscord application設定なので移動せず、2つの `bots` map がmergeされることはありません。

## 環境変数

| 変数 | 用途 |
|---|---|
| `DISCORD_BOT_TOKEN` | `discord.bots.personal.tokenEnv` の標準値。`personal` Bot トークン（必須） |

設定ファイルはプロジェクトルートの `config/` 配下から読み込まれ、ファイルパスを環境変数で変更する機能はありません。API キーなどプロバイダー固有の変数は `.env.example` を参照。

## 再起動なしに反映されるか

| 設定 | 反映タイミング |
|---|---|
| `credentials` | 再起動が必要（起動時に読み込みキャッシュ） |
| `groups` | 再起動が必要（起動時に読み込みキャッシュ） |
| `cron` | 再起動が必要（起動時に読み込みキャッシュ） |
| `bots` | 再起動が必要（process lifetime cache） |

`credentials` と `groups` は起動時に読み込みに失敗すると `process.exit(1)` するため、修正後は再起動が必要（`config/credentials.json` / `config/groups.json` 自体が存在しない場合も同様にエラーで起動失敗する）。

`cron` は起動時に `loadAndValidateCron()` が一度だけ読み込んだ結果をメモリ上の `_jobs` にセットし、`tick()` はそれを毎分参照するだけでファイルの再読み込みは行わない。そのため一度起動した後は `config/cron.json` を変更しても再起動するまで反映されない（`docs/spec/cron.md` と同じ）。

`config/cron.json` は省略可能な設定のため、起動時に存在しなくても `loadAndValidateCron()` はエラーにせず空配列を返し、cron が空扱いで起動する。ただしこの場合も後から `config/cron.json` を配置しても再起動しない限り反映されない。`config/credentials.json` / `config/groups.json` は必須設定のため、欠落時は process.exit(1) で起動自体が止まる点が異なる。

`config/bots.json` はプロセスの存続期間中キャッシュされるため、変更後は再起動が必要。ファイルが未配置の場合は空の Registry で起動するが、起動後に配置しても再起動するまで反映されない。

## 変更履歴（歴史的背景）

以下は変更当時の説明です。旧パスや統合先を現行設定として使わず、現在の形式は本書の各設定節を参照してください。

### groups/{name}/group.json の統合（#93）

旧: `groups/{name}/group.json` にモデル・ツール・allowMention・toolLogArgs・skills を設定
新: グループ設定ファイル（現在は `config/groups.json`）の `groups[].model` / `groups[].tools` / `groups[].allowMention` / `groups[].toolLogArgs` / `groups[].skills` に統合

**理由**: `groups/{name}/` はサンドボックスコンテナに `/workspace` として書き込み可能でマウントされるため、`group.json` をそこに置くとエージェント自身がモデルやツールの設定を書き換えられてしまう。コンテナにマウントされない設定ファイル側に移すことでこれを防ぐ。

### config ファイルの統合（#76）

旧: `config/groups.json` / `config/cron-jobs.json` / `config/credential-proxy.json` の3ファイル
新: `config/config.json` に `groups` / `cron` / `credentials` キーとして統合

**Breaking change**: `CREDENTIAL_PROXY_PATH` 環境変数を廃止。現在は `config/` 配下の専用ファイルを読み込みます。

### config ファイルの再分割（#137）

旧: `config/config.json` 1ファイルに `defaultModel` / `credentials` / `groups` / `cron` / `poller` を統合
新: `config/credentials.json` / `config/groups.json` / `config/cron.json` を独立ファイルに再分割し、`config/config.json` には共通設定のみ残す。その後、provider 実行ポリシーは `config/providers.json` に分離した

**理由**: 単一ファイルに役割の異なる設定（機密情報の `credentials`、人手で頻繁に編集する `groups`、運用上省略可能な `cron`）が混在しており、ファイル単位での差分管理・パス上書きがしづらかった。

**Breaking change**: 後方互換なし。既存の `config/config.json` から `credentials` / `groups` / `cron` の各キーを手動で `config/credentials.json` / `config/groups.json` / `config/cron.json` に分離する必要があります。現在はこれらの専用ファイルを `config/` 配下から読み込みます。
