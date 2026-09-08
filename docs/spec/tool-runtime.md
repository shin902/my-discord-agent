# Tool Runtime

Tool Proxyは、`agent-reach`、`arxiv-search`、`arxiv-survey`、`hackernews-search`、`github-recent-search`を **Tool callごとの使い捨てコンテナ** で実行します。取得・外部CLI・parser・scratchはRuntime内で完結し、hostへの取得fallbackはありません。Registry内部で `host` / `sandbox` / `runtime` を区別し、Agentの設定や引数から実行先・image・mount・entrypointを選ばせません。

```text
Agent sandbox: native Tool / Skill → tool-proxy CLI
  → 同じrun tokenでTool Proxyの認可・引数確定・設定済みapproval
  → hostが docker run --rm -i を起動
  → JSON stdin → 登録済み実装 → JSON stdout → 終了・破棄
```

RuntimeにHTTP入口・待受port・service tokenはありません。Credential Proxyの責務は変わりません。Tool名・schema・実装の対応は [共通Runtime定義](../../src/tools/runtime-capabilities.ts) をhost RegistryとRuntime dispatchで共有します。今回移していない天気・Tavily・既存GitHub Tool・Mail・Calendarはhost executorを使います。

## runの権限と提示

利用可能capabilityはeffective `tools` のProxy対象と、effective `skills` の組込依存の和集合です。設定の継承・配列完全置換を解決してから求めます。Skill本文やworkspace内manifestは権限の情報源にしません。

| Skill | 組込依存 |
| --- | --- |
| agent-reach | agent-reach |
| arxiv-search | arxiv-search |
| arxiv-survey | arxiv-survey |
| last30days | hackernews-search、github-recent-search、agent-reach |

`skills: "*"` はこの表の依存だけへ展開し、他のcapabilityを許可しません。依存の解決は配置状態に左右されませんが、promptへ載せるSkill一覧は実際にインストール済みのものだけです。native schemaは `tools` で選択したものだけを提示し、`/skill` / `./command` の選択チェックも維持します。bashは自動付与しません。

native Toolと `tool-proxy <capability> '<JSON引数>'` は同じrun tokenを使います。CLIにはhostから `TOOL_PROXY_URL` / `TOOL_PROXY_TOKEN` を渡します。Toolだけで選択されたcapabilityもCLIから利用できます。Skillだけの選択でも組込依存を使えます。

`approvalRequiredTools` は引き続きeffective `tools` に含まれるhost/runtime capabilityだけに指定できます。Skill単独capabilityへの設定拡張は採用していません。必要なら対応Toolを `tools` にも追加してください。設定したapprovalはnative／Skill双方に適用され、表示・承認した実効引数をそのまま実行します。接続切断・run revokeはapproval待ちと実行中の処理を中断します。

## コンテナと成果物の寿命

hostが一意なcontainer名を生成します。正常・処理エラー終了時は `--rm`、abort／timeout時はその正確な名前への `docker kill` を使います。作成前の中断では短時間だけ同じ名前へのkillを再試行します。Dockerが応答せず終了確認できない場合はcleanupエラーにし、次回起動の回収対象に残します。host shutdownでは新しいTool Proxy runの受付を閉じ、既存authorityをrevokeして実行中Runtimeを停止します。

host起動時のcleanupは `my-discord-agent.tool-runtime=<checkout絶対パスのhash>` という専用labelだけを対象にします。Agent sandboxや別checkoutのRuntimeを名前prefixで巻き込みません。稼働ディレクトリを移す場合、移動前のhostを正常停止してから移してください。

stdinは1 MiB、構造化stdoutは64 MiBが上限です。取得処理の既存timeout・応答サイズ制限も維持します。Dockerやbrowserのstderrは先頭16 KiBまで保持し、失敗時だけcontainer名とともにhost logへ出します。上限超過は切り詰めを明示し、以降もpipeをdrainします。内部診断はAgentへのresponseに含めません。取得元の失敗は成功した空結果へ変換しません。

Runtimeは長い結果も本文で返します。native結果の50,000文字超の外部化はAgent sandbox側の [output.ts](../../src/tools/output.ts) に集約し、同じAgent run中の後続read／grepで再利用できます。Runtime callの終了でこのファイルは消えません。Agent sandboxの終了後は過去pathの再読を保証しません。Skillはstdoutを維持し、`>` による保存やworkspaceへの明示copyもAgent側で行います。共有workspace・artifact store・session永続化は追加していません。

## networkとReddit state

Runtimeのfirewallはpublic Internetを許可し、private／link-local／CGNAT／metadata相当／multicast等を拒否します。公開DNSを指定し、Docker embedded DNS用のloopback例外を維持します。agent-reachのURL・DNS・redirect検証も維持し、firewall設定後は非root UID/GIDへ切り替えて全capabilityをdropします。

Redditを使わないcallはstateを参照せず、UID/GID 1000で実行します。通常のReddit取得は `data/reddit-cookies.json` だけをread-only mountします。hostが固定pathと非root所有者を確認し、そのUID/GIDを使います。maintenanceだけが同じ所有者の `data/reddit-browser-profile/` とCookieをread/write mountします。stateが無い場合もarXivやHN等は起動できます。

Cookie更新はhostの `pnpm reddit:refresh` または既存cronから単発maintenance containerで実行します。maintenanceはAgent-facing capabilityに登録しません。CookieはRuntime内で読み、固定されたReddit取得へだけ付けます。初回loginは従来の `pnpm reddit:login` です。

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

### 配置済みSkillの更新

`ensureGroupSkills` は既存Skillを自動上書きしません。`agent-reach`、`arxiv-search`、`arxiv-survey`、`last30days` を使う各groupで、**カスタマイズとの差分を確認して**更新します。

```sh
group=YOUR_GROUP
skill=arxiv-search
diff -ru "groups/$group/SKILLS/$skill" "templates/SKILLS/$skill"
```

更新対象はagent-reachの `scripts/agent-reach.sh`、arXivの `scripts/search.py` / `scripts/survey.py`、last30daysの `scripts/reddit-search.sh` と新規 `hn-search.sh` / `github-search.sh`、各 `SKILL.md` です。カスタマイズが無いことを確認したファイルだけテンプレートからcopyし、独自手順は共通CLIを呼ぶよう手動で統合します。Skillフォルダを無条件に削除・上書きしないでください。

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
