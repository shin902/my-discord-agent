# Tool Runtime 実装・検証の構成

[合意済み計画](tool-runtime.md) と [用語](../../CONTEXT.md) を基準に、main `52b5127` から独立して実装する。現行の利用・導入契約は [Tool Runtime仕様](../spec/tool-runtime.md) に集約する。PR #399への変更・push・mergeは行わず、組合せは別checkoutで検証する。

## 実装の分割

| 段階 | 追加・更新する責務 | 削除する特殊処理・検証 |
| --- | --- | --- |
| Runtime登録・dispatch | `runtime-capabilities.ts` をhost RegistryとRuntimeで共有し、executorにruntimeを追加 | agent-reachの重複metadata／専用capability clientを削除。今回対象外のhost Toolは移さない |
| 単発実行 | `tool-runtime-client.ts` の固定Docker起動・stdin/stdout・名前指定kill、`tool-runtime.ts` の一回dispatch | HTTP server・port・call map・DELETE cancel・service token・常駐Composeを削除 |
| authority | `skill-capabilities.ts` で組込依存をeffective configから解決、managerで一つのrun tokenを配布 | Skill専用token・payload・env・revokeを削除。Proxyのapproval・materializationを共用 |
| frontend | `tool-proxy-cli.ts` とnativeが同じwire clientを利用 | 各Skillの重複HTTP通信、Python arXiv取得/parser、last30days直接curlを削除 |
| 機能 | arXivはnative TSのparserを維持。HNは `hackernews-search`、公開Issues/PR検索は `github-recent-search` | query/date/sort/limit、JSON配列stdout、既存日本語見出しをfixtureで比較 |
| Reddit・運用 | 取得はCookieのみread-only mount、maintenanceはprofileとCookieの単発処理 | maintenance HTTP/tokenとgeneric起動のReddit依存を削除。配置済みSkillの差分移行を文書化 |
| 終了・成果物 | Proxyのdisconnect／revokeとhost shutdownを共通中断へ接続。Agent側output boundaryを維持 | Runtime内pathの返却や共有artifact基盤を作らず、実Dockerで寿命を検証 |

## 判断

- Skill単独capabilityへの `approvalRequiredTools` 設定拡張は見送る。既存のeffective tools包含検証を維持し、runtime executorを対象に追加する。設定済みapprovalをnative／Skill共通経路へ適用することを必須条件にする。
- image設定はhost共通の `TOOL_RUNTIME_IMAGE` のみ。Agentにimage・mount・任意script選択を公開しない。
- cleanupは `docker run --rm`、正確なnameへのkill、checkout別の専用labelによるstartup cleanupに限定する。create/start分割・永続job管理・reconciliation frameworkは追加しない。
- arXivはnative TS正規化を正本にし、updated欠落・匿名entryの重複排除・引用符等の置換後の空白の差を移行文書に記録する。

## 検証の組み立て

1. Registry／manager／config／Tool Proxyの回帰testに加え、実CLI subprocessと実Proxyを使って共通token、Toolだけ／Skillだけ／両方／非選択、wildcard、approval、revoke、接続切断を検証する。
2. arXivの同一Atom fixtureをnativeとPython entrypointへ通し、stdout・引数・正規化を比較する。last30daysは固定upstream responseからAPI条件と表示を検証する。
3. 実Runtime imageからテスト専用imageを作り、取得先だけをfixtureに置き換える。実Docker起動・firewall・権限drop・stdin/stdout・成果物・実子processの停止・専用label cleanupを確認する。Redditはtemporaryな偽stateだけを使う。
4. Agent sandbox内のoutput/read/grepとCLI redirectionを実行し、Runtime破棄・次のTool callの後も同じrunの成果物が読め、Agent containerの入替後は以前のpathが無いことを確認する。
5. #399との隔離組合せで、Agent direct egressを再許可せずに対象capabilityの実Proxy／Runtime経路を検証する。
6. `DOTENV_CONFIG_PATH=/dev/null` でCI同等format／lint／typecheck／test、両bundleと両imageのbuildを実施し、自己レビュー後にcommit・push・Issue #402を閉じるPRを作る。merge／deployは行わない。

## 実施結果（2026-09-08）

Node.js 22.23.2 / pnpm 10.24.0 / Docker 29.7で、すべてのtestを `DOTENV_CONFIG_PATH=/dev/null` に分離して実施した。

| 検証 | 結果 |
| --- | --- |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` / `pnpm build` | 成功 |
| `pnpm build:runner` / `pnpm build:tool-runtime`、両Dockerfileのimage build | 成功 |
| 本PR単独の `pnpm test`（両test imageを指定） | Vitest 109 files / 1,559 passed、#399専用1件skip。Python 3 passed |
| #399 `5d44bbd` との隔離組合せのformat / lint / typecheck | 成功 |
| 組合せの `pnpm test`（Runtime image + network制限済みRunner image） | Vitest 110 files / 1,563 passed、skipなし。Python 3 passed |

単独testのimage指定は `TOOL_RUNTIME_TEST_IMAGE=my-discord-agent-tool-runtime:issue402-test` と `TOOL_RUNTIME_AGENT_TEST_IMAGE=my-discord-agent-runner:issue402-test`。組合せでは後者の代わりに `SANDBOX_NETWORK_TEST_IMAGE=my-discord-agent-runner:issue402-network-test` を指定した。test imageは本番tagと分離し、upstream fixtureとtemporaryな偽Reddit stateだけを利用した。

実Dockerでは通常／エラー終了、名前指定abort、timeout、host shutdown、実子processの消失、専用labelだけのstartup cleanup、非Reddit起動、Cookieのread-only mountとmaintenanceの永続化を確認した。Agent内ではnative／CLIの実経路、長文のread／grep、後続call後の再読、workspaceへのcopy、次runでの旧tmp pathの消失を確認した。

自己レビューでapproval待ち中の接続切断を実行signalへ接続し、CLI symlinkからの起動と空応答のエラー処理を確認した。全体testで判明したsession-directoryの競合はqueue integration testのtemporary directory化だけで解消した。組合せの遮断probeは判定後に明示終了させ、Docker testの時間枠に揃えた。

### #399を後からrebaseする際の引継ぎ

組合せは別のdetached worktreeにのみ適用した。元の#399 checkout / branch / HEADには変更を加えていない。

- Dockerfileでは共通CLIと `sandbox-entrypoint.sh` の両方をcopyする。
- managerのnetwork port選択は `toolProxyRun` だけで判定する。廃止済み `agentReachToolProxyRun` を参照しない。
- 旧Runtime HTTPを使うnetwork integration fixtureを本PRの実Runtime launcher / fixture imageへ変更する。隔離検証では実Agent loop、Credential Proxy、Tool Proxy、使い捨てRuntimeを通し、取得結果がLLMの次requestへ届くことまで確認した。旧HTTP専用live smokeはその検証checkoutから除去した。
- 本PRの `tool-runtime-agent.integration.test.ts` に `SANDBOX_NETWORK_TEST_IMAGE` を指定すると、#399の実 `sandboxNetworkArgs` を使って全frontendと成果物の寿命、非許可host portの遮断を再検証できる。#399の既存network testもpublic/private/loopback/DNS/UDPの遮断と権限dropを検証した。
- CIのRunner buildを共用し、network testにもRuntimeのtest imageを渡す。security / 導入順の文書は移行済みの状態に合わせる。

公開APIのlive応答や本番Reddit loginの可用性はfixture testの検証対象ではない。導入時は[移行手順](../spec/tool-runtime.md#導入旧構成からの移行)に従い、host・両image・配置済みSkillを更新する。
