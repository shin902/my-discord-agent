# Tool Runtime

Tool Proxyは、`agent-reach`、`arxiv-search`、`arxiv-survey`、`hackernews-search`、`github-recent-search`、`x-search`を **Tool callごとの使い捨てコンテナ** で実行します。取得・外部CLI・parser・scratchはRuntime内で完結し、hostへの取得fallbackはありません。Registry内部で `host` / `sandbox` / `runtime` を区別し、Agentの設定や引数から実行先・image・mount・entrypointを選ばせません。

```text
Agent sandbox: native Tool / Skill → tool-proxy CLI
  → 同じrun tokenでTool Proxyの認可・引数確定・設定済みapproval
  → hostが docker run --rm -i を起動
  → JSON stdin → 登録済み実装 → JSON stdout → 終了・破棄
```

RuntimeにHTTP入口・待受port・service tokenはありません。Credential Proxyの責務は変わりません。Tool名・schema・実装の対応は [共通Runtime定義](../../src/tools/runtime-capabilities.ts) をhost RegistryとRuntime dispatchで共有します。今回移していない天気・Tavily・既存GitHub Tool・Mail・Calendarはhost executorを使います。

## runの権限と提示

利用可能capabilityはeffective native `tools` のhost/runtime対象と、effective `toolSets` のtrusted bundleの和集合です。設定の継承・配列完全置換を解決してから求めます。bundleの正本はtrusted codeの [`TOOL_SETS`](../../src/tools/tool-sets.ts) です。`skills` は説明・workflowの公開だけを制御し、Skillの名前・内容・存在・hash・workspace内manifestは権限の情報源にしません。

| toolSet | capabilities |
| --- | --- |
| web | agent-reach、tavily-search、arxiv-search、arxiv-survey、hackernews-search、github-recent-search、x-search |
| github | list-issues、read-issue、read-pull-request、list-issue-comments、list-pull-request-comments、comment-issue |
| mail | list-emails、read-email |
| calendar | list-calendars、list-events、read-event、create-event、update-event、delete-event |
| weather | get-current-weather、get-weather-forecast |

`toolSets` は上表の名前を明示指定します。未知名や `"*"` は設定エラーです。未指定なら親を継承し、`[]` はbundle許可を解除します（native `tools` の権限は別です）。`skills: ["*"]` にも全選択の意味はありません。

`skills: ["github"], toolSets: []` だけではGitHub capabilityは許可されません。逆に `skills: [], toolSets: ["github"]` はcapabilityだけを許可し、Skill説明をpromptへ追加しません。promptへ載せるSkill一覧は明示指定された配置済みのものだけです。native schemaは `tools` で選択したものだけを提示し、`/skill` / `./command` の選択チェックも維持します。bashは自動付与しません。

native Toolと `tool-proxy <capability> '<JSON引数>'` は同じrun tokenを使います。CLIにはhostから `TOOL_PROXY_URL` / `TOOL_PROXY_TOKEN` を渡します。native Toolだけで選択されたcapabilityもCLIから利用できます。Skillだけの選択ではcapabilityは増えません。

`approvalRequiredTools` はeffective `tools`または上表のeffective `toolSets`に含まれるhost/runtime capabilityに指定できます。設定したapprovalはnative／Skill双方に適用され、表示・承認した実効引数をそのまま実行します。接続切断・run revokeはapproval待ちと実行中の処理を中断します。

### Tool contractの段階的開示

1. `SKILL.md` でcapability一覧と用途を確認します。
2. `tool-proxy describe <capability>`（または `bash SKILLS/web/scripts/web.sh tavily-search`）で必要な1件だけのcontractを取得します。
3. `tool-proxy <capability> '<JSON arguments>'`（または同じSkill scriptにJSONを追加）で実行します。

describeは同じRPCへ `{ "operation": "describe", "capability": "..." }` を送り、`{ "result": { "name": "...", "description": "...", "parameters": { ... } } }` を返します。CLIのstdoutはこのcontract objectです。現在のrun tokenとallowed capabilityの検証は実行と共通で、未認可capabilityのschema/descriptionは返しません。認可後に `getCapabilityDefinition()` / `factory()` から既存 `AgentTool` のname・description・TypeBox parametersを取得し、別schemaは定義しません。descriptionの安全上の契約（削除前の確認など）も実行前に確認してください。

describeはread-onlyで、approval・引数materialize・host executor実行・Tool Runtime起動を行いません。実行時のvalidation・approvalは従来どおり維持します。Skill scriptはcapability固有schemaやoption定義を持たず、raw JSONを無変換で渡します。

## コンテナと成果物の寿命

hostが一意なcontainer名を生成します。正常・処理エラー終了時は `--rm`、abort／timeout時はその正確な名前への `docker kill` を使います。作成前の中断では短時間だけ同じ名前へのkillを再試行します。Dockerが応答せず終了確認できない場合はcleanupエラーにし、次回起動の回収対象に残します。host shutdownでは新しいTool Proxy runの受付を閉じ、既存authorityをrevokeして実行中Runtimeを停止します。

host起動時のcleanupは `my-discord-agent.tool-runtime=<checkout絶対パスのhash>` という専用labelだけを対象にします。Agent sandboxや別checkoutのRuntimeを名前prefixで巻き込みません。稼働ディレクトリを移す場合、移動前のhostを正常停止してから移してください。

stdinは1 MiB、構造化stdoutは64 MiBが上限です。取得処理の既存timeout・応答サイズ制限も維持します。Dockerやbrowserのstderrは先頭16 KiBまで保持し、失敗時だけcontainer名とともにhost logへ出します。上限超過は切り詰めを明示し、以降もpipeをdrainします。内部診断はAgentへのresponseに含めません。取得元の失敗は成功した空結果へ変換しません。

Runtimeは長い結果も本文で返します。native結果の50,000文字超の外部化はAgent sandbox側の [output.ts](../../src/tools/output.ts) に集約し、同じAgent run中の後続read／grepで再利用できます。Runtime callの終了でこのファイルは消えません。Agent sandboxの終了後は過去pathの再読を保証しません。Skillはstdoutを維持し、`>` による保存やworkspaceへの明示copyもAgent側で行います。共有workspace・artifact store・session永続化は追加していません。

## networkとReddit state

Runtimeのfirewallはpublic Internetを許可し、private／link-local／CGNAT／metadata相当／multicast等を拒否します。公開DNSを指定し、Docker embedded DNS用のloopback例外を維持します。agent-reachのURL・DNS・redirect検証も維持し、firewall設定後は非root UID/GIDへ切り替えて全capabilityをdropします。

Redditを使わないcallはstateを参照せず、UID/GID 1000で実行します。通常のReddit取得は `data/reddit-cookies.json` だけをread-only mountします。hostが固定pathと非root所有者を確認し、そのUID/GIDを使います。maintenanceだけが同じ所有者の `data/reddit-browser-profile/` とCookieをread/write mountします。stateが無い場合もarXivやHN等は起動できます。

Cookie更新はhostの `pnpm reddit:refresh` または既存cronから単発maintenance containerで実行します。maintenanceはAgent-facing capabilityに登録しません。CookieはRuntime内で読み、固定されたReddit取得へだけ付けます。初回loginは従来の `pnpm reddit:login` です。

## X検索state

`x-search`だけ、hostの`data/twitter-cookies.json`をRuntime内の固定pathへread-only mountします。ファイルはGit管理外で、内容は次の2値だけです。

```json
{
  "auth_token": "...",
  "ct0": "..."
}
```

RuntimeはSearchTimeline POST対応済みの`twitter-cli` commit `7c634e0d396b1e7af9f63315b414925fe4f29ae7`をGitHub archiveからSHA固定で導入し、argvで起動します。state fileの非root owner UID/GIDへRuntimeをdropしてから、値を子process環境へだけ渡します。Agent引数・結果、`docker run`の環境変数・argv、host logへcredentialやraw authenticated responseを載せません。通常検索ではブラウザprofileをmountしません。`pnpm x:login` / `pnpm x:refresh` / `x-cookie-refresh` cronはhost-onlyのPlaywright処理です。X maintenanceのRuntime protocol、profile / 出力ディレクトリmountはありません。初回ログインとrefreshは[X Cookieセットアップ](../guides/x-cookie-setup.md)を参照してください。認証失効、rate limit、CLI / upstream変更は空結果ではなく固定診断の失敗になります。利用するgroup / channel / cronのeffective `tools`へ`x-search`、または`toolSets`へ`web`を明示し、Runtime imageとhostを同時に更新してください。

## 導入・旧構成からの移行

Agent sandboxは必要なhost Proxy port以外へのdirect egressを拒否します。対象機能はTool Proxy経由で実行するため、旧構成から更新する場合は以下の移行と[network boundaryの導入](../sandbox-command.md#network-boundary-の導入)を合わせて行ってください。

1. 旧hostアプリを正常停止し、**旧checkoutで**、既存と同じCompose project名・ファイルを使って `docker compose -f compose.tool-runtime.yaml down` を実行します。Redditのbind mount元は保持してください。新checkoutにはこの旧Composeファイルはありません。
2. hostの `AGENT_REACH_RUNTIME_URL` / `AGENT_REACH_RUNTIME_TOKEN` / `AGENT_REACH_REFRESH_TOKEN` を削除します。旧Skill専用の `AGENT_REACH_TOOL_PROXY_URL` / `AGENT_REACH_TOOL_PROXY_TOKEN` も使いません。新しいservice tokenは不要です。
3. 新しいRuntime imageを事前buildします。既定名以外ならhostの `.env` に `TOOL_RUNTIME_IMAGE` を設定します。呼び出し時のimage build／自動pullは行いません。

   ```sh
   pnpm build:tool-runtime
   docker build -f Dockerfile.tool-runtime -t my-discord-agent-tool-runtime:latest .
   ```

4. `pnpm build:runner` でRunnerと共通CLIをbuildし、通常のRunner image更新手順（`pnpm sandbox build`）で配布します。hostも `pnpm build` で更新します。
5. 以下の手順で配置済みSkillを更新してからhostを再起動します。host・Runtime image・Runner image・配置済みSkillを揃えてください。新しいhost共通image設定は再起動で反映します。
6. Redditを利用する環境だけ、既存stateを保持してhostで `pnpm reddit:refresh` を実行します。初回loginが必要な場合は [Redditセットアップ](../guides/reddit-cookie-setup.md) を参照してください。

imageが無い場合はprebuilt imageの設定エラー、CLIが無い場合はRunner更新を要するエラーになります。旧HTTP Runtimeや直接Internet経路へfallbackしません。

### skillsからtoolSetsへの権限移行

旧 `skills -> capability` の暗黙grantは削除しました。旧 `agent-reach` / `arxiv-search` / `arxiv-survey` / `last30days` も例外ではありません。利用を継続するgroup/channel/cron/Botのtrusted configへ `toolSets: ["web"]` を明示するか、必要な個別capabilityをnative `tools` に指定してください。`web` は7 capabilityを許可するため、不要な権限まで許可したくない場合は個別 `tools` を使います。GitHub等もそれぞれ必要なbundleだけを明示します。Skill directoryを検査して権限を自動移行することはありません。

例: `tools: ["bash"], skills: ["web"], toolSets: ["web"]`。制限された子layerでは必要に応じて `toolSets: []` も指定し、継承したbundleを解除してください。config変更後はhostを再起動し、describe対応CLIを含むRunner imageと配置済みSkill scriptも更新します。

### 配置済みSkillの更新

`ensureGroupSkills` は既存Skillを自動上書きしません。新しい`web`、`github`、`mail`、`calendar`、`weather`を使うgroupへtemplateを追加します。旧`agent-reach`、`arxiv-search`、`arxiv-survey`から`web`へ移行する場合も、**カスタマイズとの差分を確認して**更新します。

```sh
group=YOUR_GROUP
skill=web
diff -ru "groups/$group/SKILLS/$skill" "templates/SKILLS/$skill"
```

全ドメインSkillのscriptは`<capability>`でcontract取得、`<capability> '<JSON arguments>'`で実行し、JSONを変換せず共通CLIへ渡します。カスタマイズが無いことを確認したファイルだけtemplateからcopyし、Skillフォルダを無条件に削除・上書きしないでください。`last30days`はworkflow Skillとして独立して維持します。

Financeを旧Skillから用途別Toolへ移行するgroupでは、`skills` から `finance` / `finance-setup` を外し、必要な8つの `finance-*` Toolを `tools` に追加します。`groups/<group>/SKILLS/finance` / `finance-setup` はテンプレート削除では自動削除されないため、独自変更が無いことを確認してから退役させてください。既存の `finance.db` は移動・再作成せずそのまま再利用します。

arXivのPython entrypoint・位置引数・`--from` / `--to` / `--limit` / `--sort`・JSON配列stdoutは維持します。CLIのlimitは1〜50の厳密検証、native側は50へのclampです。取得・正規化はnative TypeScriptへ統一し、旧Pythonとの差は次のとおりです。

- updated欠落時は投稿日へfallbackします。
- ID欠落時はlinkを使い、IDもlinkも無いentryは同じ空keyとして最初の1件に重複排除します。
- queryの空白は引用符・backslashを置換する前に正規化します。置換により生じる連続空白は再圧縮しません。

last30daysはHNのAlgolia story検索（直近30日・10件）、公開GitHub Issues/PR検索（`updated:>`・reactions順・5件）、Reddit検索（top/month/10件）を別々のcallで使います。GitHub Discussions APIへの変更や新しいcredential依存はありません。既存の日本語集約見出しも維持します。

## 検証

通常testは `DOTENV_CONFIG_PATH=/dev/null pnpm test` で実設定から分離します。Docker testはfixtureだけを追加した別image、temporaryなReddit state、専用labelを使います。

```sh
DOTENV_CONFIG_PATH=/dev/null \
  TOOL_RUNTIME_TEST_IMAGE=my-discord-agent-tool-runtime:latest \
  TOOL_RUNTIME_AGENT_TEST_IMAGE=my-discord-agent-runner:latest \
  pnpm exec vitest run src/runtime/tool-runtime.integration.test.ts src/runtime/tool-runtime-agent.integration.test.ts
```

公開APIのlive結果や本番Cookieは受け入れfixtureに使いません。Agentのdirect egressを閉じたまま、Agent sandbox → Tool Proxy → 実際の使い捨てRuntimeの経路を検証します。
