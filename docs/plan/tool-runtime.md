# Tool Runtimeの汎用化とTool call単位の使い捨て実行

## このIssueの目的と状態

`agent-reach` 専用Runtimeを、Tool Proxy配下の汎用Tool Runtimeへ変更する。Runtimeは**Tool callごとにcontainerを起動し、一回の処理が終わったら破棄する**。`agent-reach`、arXivのTool／Skill、`last30days` の既存取得機能をこの構成で動かし、Agent sandboxのdirect egressを閉じるPR #399を先行移行なしで導入する問題を解消する。

これは実装前の計画資料である。以下の「合意済み」はユーザーとの設計確認の結果であり、現行mainの実装済み仕様を意味しない。背景を知らない実装担当エージェントは、本Issueと参照先を読み、ファイル単位の変更・検証・移行手順を含む詳細実装計画を作成すること。

調査基準は2026-09-08に確認したmainの `52b5127dd9569ed55390bd1bd86a0e815382b91b`。調査時のcheckoutはPR #399の `feat/agent-sandbox-network-boundary`、HEADは `5d44bbd` だった。Runtime／Toolの対象実装は、この時点ではmainと同じだった。実装着手時には最新mainとPR #399の差分を再確認すること。

## 背景

- Tool Proxyは、Agent runに許可されたcapabilityを認可し、引数を検証して実行する既存の境界である。
- 現在の `agent-reach` はTool Proxyのhost handlerから専用の常駐Runtimeへ委譲される。取得、外部CLI、parser、一時ファイル操作は既にRuntime内で行われる。
- nativeな `arxiv-search`／`arxiv-survey` はTool Proxyを通るが、HTTP取得とAtom parserはhostで実行される。
- arXivのPython Skillは独自の取得・parser実装を持ち、Agent sandboxからInternetへ直接接続する。
- `last30days` はRedditだけTool Proxy経由で、HN／GitHub検索はSkill内の直接curlである。
- #399はAgent sandboxのdirect egressを閉じる。既存のarXiv Skillとlast30daysの直接取得は、そのままでは動かなくなる。
- 現在のRuntimeにはagent-reach専用のHTTP通信・token・呼び出し管理があり、Skillにも専用token発行と重複した通信処理がある。これらをToolごとにコピーして増やさない。

Project Memoryは経緯を確認する資料として扱い、正本・変更禁止の制約として扱わない。過去の説明には現状と違うものや、今回不要な複雑性を導くものがある。本Issueで明示した合意、現在のコード、実際の利用条件を照合すること。特に、過去の「長寿命Runtime」「Runtime HTTPのservice認証を維持する」という判断は、今回合意した使い捨て／HTTP入口廃止の方針で更新する。

## 用語

| 用語 | 本Issueでの意味 |
| --- | --- |
| Agent run | 一つのAgent実行。複数のTool callを含み得る |
| Capability | 名前・入力・結果の契約を持ち、runへ利用を許可できる機能 |
| Native Tool | Capabilityをモデルの構造化Tool呼び出しとして提示する入口 |
| Skill | Agentへ作業手順を提示するもの。複数のcapabilityを利用する場合がある |
| Tool call | 一つのcapabilityの一回の実行。SkillのCLIからの呼び出しも含む |
| Tool Proxy | run権限、capability認可、引数検証、設定されたapprovalを担当する境界 |
| Tool Runtime | Agent自身の作業環境から分離した、Tool実装の実行環境 |
| Agent sandbox | AgentがbashやローカルToolで作業する既存の実行環境 |
| Runtime private scratch | CLI・parser等が途中で使う、Agentへ直接公開しない作業データ |
| Agentの成果物 | 取得結果をAgent側で再利用・保存するためのデータ。Runtime scratchとは別の寿命を持つ |

「毎回破棄」はAgent runごとではなく、**Tool callごと**を指す。ToolとSkillの提示方法が違うことを理由に、同じcapabilityへの別々の実行権限を作らない。

## 合意済みの設計

### 1. 実行経路

```text
Agent sandbox
  ├─ native Tool（description / schema）
  └─ Skill → 薄い共通CLI（stdout / stderr）
         ↓ 同じrun token
Tool Proxy
  └─ capability認可 → 引数検証・実効値確定 → 設定されたapproval
         ↓ trustedなCapability Registryで実行先を選択
         ├─ 既存host executor（今回移さないTool）
         └─ host側のDocker起動処理
               ↓ 構造化JSONをstdinへ渡す
             Tool Runtime container（一回のTool call）
               └─ 登録済みTool実装 → 結果をstdoutへ返す → 終了・破棄
```

- AgentからTool Runtimeへ直接HTTP接続する経路は作らない。
- imageは事前にbuildして再利用し、呼び出しごとにimageをbuildしない。
- hostはcontainerの起動・入出力・終了管理を担当する。移行対象の外部CLI・parser・取得処理そのものをhostで実行するfallbackは設けない。
- Runtimeは登録済みのTool実装を実行する。Agent指定のshell command、image、mount、entrypoint、任意scriptを実行する汎用APIにはしない。
- 現在のRuntime HTTPサーバー、待受port、service token、maintenance用HTTP token、HTTP call map、DELETEによるキャンセル経路は不要になる。
- これは認証だけを外してHTTP endpointを残す変更ではない。**Runtime HTTP入口そのものを廃止する**。Tool Proxyのrun tokenと認可は維持する。

### 2. Registryと設定

- 実行先は既存の `src/tools/registry.ts` を中心とするCapability Registryのtrustedな定義で指定する。
- Tool名・description・schemaを別RegistryやSkill専用定義へコピーしない。Runtime側のdispatchも、この登録情報と食い違う別の手書き一覧を正本にしない。
- 共有のためにMail／Calendar等をimportするhost Registry全体をRuntimeへ持ち込む必要はない。Runtime対象の小さな共通定義集合を既存Registryへ組み込む形も候補とし、無関係な依存を増やさない。
- Registry内部のexecutor区分に `"runtime"` を追加し、`executor: "host" | "sandbox" | "runtime"` とする。`host` は既存host処理、`sandbox` はAgent sandbox内の処理、`runtime` はTool callごとのTool Runtime実行を表す。Agent-facingな新しいexecutor選択項目は追加しない。
- `runtime` もTool Proxyの認可・引数検証・設定済みapprovalを通る。現在 `executor === "host"` でProxy対象やapproval対象を判定している箇所は、`host` と `runtime` の両方を対象にする。これは実行先区分の追加に必要な対応であり、後述の条件付き「Skill単独capabilityへのapproval指定」拡張とは別である。
- 運用者は従来どおり `tools`／`skills` で利用する機能を選択する。ToolごとのRuntime/token/port設定は追加しない。
- image指定等が必要ならhost側の共通設定に限る。Tool引数や書換可能なSkill本文からcontainer起動条件を受け取らない。
- `tools`／`skills` の既存の階層継承・配列完全置換を維持する。実効設定を解決した後にcapabilityの集合を求めるのであって、親子設定の配列を暗黙に加算する変更ではない。

### 3. Tool／Skill共通のrun権限

次の集合を一つのTool Proxy run authorityにまとめる。

```text
利用可能capability
  = effective toolsで選択されたProxy対象capability
    ∪ effective skillsに対応する既知の必要capability
```

- native用・agent-reach Skill用に別々のrun tokenを発行する現行処理を廃止する。
- agent-reachとlast30daysが利用する `AGENT_REACH_TOOL_PROXY_URL`／`AGENT_REACH_TOOL_PROXY_TOKEN`、専用payload項目、専用revoke処理を共通経路へ置き換える。
- Tool Proxyの接続先とtokenはnative ToolとCLIで共有する。CLIは別のauthorityを発行しない。
- Skill→必要capabilityはtrustedなコード側で対応付ける。任意の `SKILL.md`、frontmatter、workspace内manifestから権限を取得する仕組みは追加しない。
- 対応は少なくともagent-reach→agent-reach、arxiv-search→arxiv-search、arxiv-survey→arxiv-survey、last30days→HN検索・GitHub検索・agent-reachを含む。新しい検索capabilityの最終名は実装計画で決める。
- `skills: "*"` は、コードに定義された対応Skillすべての既知の必要capabilityへ展開する。**全Registry capabilityの許可ではない**。配置されているSkillの有無によって権限集合を変えない。
- wildcardでプロンプトに載せる説明は、従来どおり実際に配置されたSkillだけ。説明の発見と実行権限を同一視しない。

既存の提示仕様は維持する。

- `tools` は選択したnative Toolのdescription・schemaをモデルへ渡す。
- `skills` は選択したSkillの名前・description・場所を通常のプロンプトへ載せる。本文は従来のロード経路を使う。
- 明示的な `/skill`／`./command` は現在のSkill選択チェックを維持する。
- 同名Skillが非選択であることを理由に、許可済みToolのcapabilityをCLIから呼べなくしない。実際にshellを使うには既存どおりbash等が必要であり、今回自動的にbashを付与しない。
- 既存のSkill単独利用も維持する。native schemaを掲載するためだけに、対応Toolを `tools` へ追加する運用を必須にしない。

### 4. approval：必須の整合と、条件付きの拡張を分ける

**必須：** 共通run authorityに設定されたapprovalは、native／Skill CLIのどちらから呼んでも同じcapabilityへ適用する。現在のSkill専用tokenがapproval設定を受け取らない例外を複製せず、Skill経由の迂回を作らない。Tool Proxyの既存の引数materialization、承認した実効引数での実行、run終了との連動を維持する。

**条件付き：** Skill単独で利用可能になったcapabilityも `approvalRequiredTools` に指定できるように、設定検証を `tools` との包含関係から共通の利用可能capability集合との包含関係へ変更する案がある。ユーザーは一度この案を選択したが、後から次の条件を追加した。

> 実装が複雑化したり、レビューで穴を突かれまくったら実装しない

したがって、この拡張は本Issueの必須完了条件ではない。既存の検証処理を共通集合へ単純に合わせる範囲で成立する場合だけ採用する。追加のpolicy state、別token、承認経路、例外処理や広い認可再設計を必要とする場合は見送る。

見送る場合は、`approvalRequiredTools` の指定対象を従来どおり `tools` に含まれるcapabilityに限る。必要な機能を `tools` にも指定すればその既存approvalが共通経路へ適用される。**拡張を見送ることと、Skill経由で設定済みapprovalを省略することは別**である。

設定未指定なら従来どおりapprovalなし。新しいapproval用設定項目や、mutation一律承認は追加しない。実装報告には拡張を採用したか見送ったかと理由を明記する。

### 5. 1 Tool call = 1 container + cleanup

**Tool call単位の使い捨ては維持し、寿命とcleanupの仕様は通常のAgent sandboxに合わせる。** `docker run --rm -i` で起動し、host側で一意なcontainer名とTool Runtime専用labelを付ける。

| 契機 | 処理 |
| --- | --- |
| 通常終了（処理成功・処理エラー） | `--rm` に任せる |
| abort／timeout | hostがそのcallに付けた正確なcontainer名で `docker kill` する。削除は `--rm` に任せる |
| host crash | 次回host起動時にTool Runtime専用labelのcontainerだけcleanupする |

Docker CLI processをkillするだけではcontainer本体は止まらないため、abort／timeoutは対象containerをkillする。通常のAgent sandboxと同じ終了処理の考え方を使い、別のlifecycle framework、create/start分割、永続job管理、reconciliation serviceは追加しない。startup cleanupではAgent sandboxや他のserviceのlabelを対象にせず、広いcontainer名のprefix一致も使わない。

Agent runのrevoke、要求接続の切断、hostの通常shutdownによる中断も、同じ対象containerのkill処理へ接続する。現在のTool Proxyは実行signalに要求接続の切断を使う一方、`run.revokeSignal` は主にapproval経路で使っているため、必要なsignalの接続を確認する。

stdoutは構造化した結果用、診断はstderrへ分け、個々のToolの既存timeout・サイズ制限を維持する。CLI診断を結果のstdoutへ混ぜず、Docker内部のmount情報や秘密を含む診断をAgentへそのまま返さない。

### 6. ファイル境界とReddit

**「Runtimeは一時ファイルしか扱えない」という制約は設けない。** agent-reachの取得・CLI・parser・ファイル処理全体がRuntimeの対象であり、以下の既存の区別を維持する。

| データ | 維持する扱い |
| --- | --- |
| 字幕、CLIの中間結果、parserのscratch | Runtime内で扱い、call終了時に破棄。AgentへRuntime内pathを返さない |
| Reddit Cookie／browser profile | trustedな永続状態。container破棄で消さず、必要時だけRuntimeへmountする |
| 小さいnative Tool結果 | 従来どおり本文を返す |
| 大きいnative Tool結果 | Agent sandboxの既存output boundaryで保存し、そのrun中にread／grepで利用する |
| Skillの結果 | stdoutを維持。必要時のshell redirectionはAgent sandbox内で行う |
| Agentが残す成果物 | workspaceへの明示的なwrite／copy等、既存の保存方法を維持する |

**追加確認済み：自動保存したTool結果の寿命はAgent sandboxのrun終了まででよい。** 同じrun内では後続のread／grepで利用できることを保証し、Tool call終了時には消さない。Agent sandboxの終了・破棄後に、次のrunから過去のpathを再読できることは要求しない。このためのセッション単位の永続化、保持期限管理、artifact storeは追加しない。

結果の文字数判定・全文保存・pathの案内は、Agent側の既存 `src/tools/output.ts` を中心とする共通output boundaryが担当する。Runtimeは結果の大小によらず、既存の応答サイズ境界内で結果本文を返す。Runtime側でAgent向け外部化を行い、破棄されるcontainer内のpathだけを返す実装にしない。Toolごとの結果ファイル管理を増やさず、Runtime内部の中間ファイルとAgentへ案内する結果ファイルを区別する。

この方針は追加調査で確認した以下の事実に基づく。

- 現行コードの約26万文字のagent-reach結果で、Runtime scratchの削除後も別のAgent向け出力ファイルをread／grepできた。後続の取得callも既存の出力ファイルを削除しなかった。外部取得にはfixtureを使い、実際のcore処理・cleanup・共通output処理を通した検証である。
- 実DockerでAgent相当containerを入れ替えると、保存したTool結果にはpathが残る一方、前のcontainerの結果ファイルは `ENOENT` になった。会話履歴とrun内ファイルの寿命が異なるためであり、このrunをまたぐ再読不能は許容する。
- 「Tool callのcleanupが、同じrun内で案内済みの結果ファイルまで消す」現象は現行の検証では確認できなかった。過去に起きた個別事象の原因を断定するものではない。

- RuntimeとAgent sandboxの共有workspace、汎用file-transfer／artifact API、新しいoutput modeは今回導入しない。対象機能は結果本文の受け渡しで成立する。
- 通常のread／write／bashや、workspaceを扱う他SkillをRuntimeへ一律に移さない。
- Redditが未設定でもarXiv・HN等の非Reddit機能は利用できるようにする。Runtimeの実行UID/GIDを「Redditのファイルが必ず存在すること」から切り離す。
- Redditを使う場合のcanonical stateは既存の `data/reddit-browser-profile` と `data/reddit-cookies.json`。初回loginの入口とCookie更新の運用を維持する。
- 通常のReddit取得はCookieを必要とし、browser profileを必要としない。maintenanceはprofileとCookieを扱う。どの固定mountを使うかはtrustedなhost側処理が決め、Agentにpathやmountを選ばせない。
- Cookie更新はhost scheduler／運用コマンドから一回のmaintenance container実行へ移す。Agent-facing capabilityとして登録しない。廃止するHTTP maintenance tokenの代わりに、新しいAgent向け権限を作らない。
- CookieをAgent sandboxの環境変数、引数、Runtime結果、一時header fileへ出さない。既存のRuntime内でCookieを読み、固定のRedditリクエストへ付ける境界を維持する。
- Reddit設定不足ではReddit処理の設定エラーを返し、他の機能の起動条件にしない。

## 実装対象と互換性

### agent-reach

取得処理は既にRuntimeへ移っている。今回の主変更は専用常駐Runtimeから共通の使い捨て実行への置換と、Skillの通信経路の共通化である。

- 名前・URL入力・サービス判定・出力／details・既存の取得先検証を維持する。
- YouTube、GitHub repo、Reddit、X、RSS、一般URLの対応を維持する。
- shell frontendの呼び出し方、stdout、redirection、非zero終了／stderrを維持する。
- X取得失敗時の別経路fallback等、今回と関係ない取得仕様の変更はしない。
- 汎用化に伴い、重複したdescription／schema、専用client、専用token、専用HTTP管理を削減する。

### arxiv-search／arxiv-survey

- native Toolの取得とAtom parserをRuntimeへ移す。
- Python SkillのHTTP取得・Atom parserを共通実装へ収束させる。Python entrypointは薄いCLIとして残してよい。
- `arxiv-search` と `arxiv-survey` は別のTool／Skillのままとし、単一Toolのmode引数へまとめない。
- 既存の `python3 SKILLS/arxiv-search/scripts/search.py ...` と `python3 SKILLS/arxiv-survey/scripts/survey.py ...`、位置引数、`--from`／`--to`／`--limit`／`--sort` を維持する。
- 検索は単一query、surveyは1〜8 queryのOR、結果は正規化済みJSON配列。searchの既定値は10件／relevance、surveyは30件／submitted。日付指定、sort、最大50件、重複排除、statelessな利用を維持する。
- CLIは `--limit` の1〜50を厳密に検証する。native側は現在上限超過をclampする。この入口ごとの違いを失わないようにする。
- Skill stdoutへTool Proxyの通信envelopeをそのまま出さず、従来のJSON配列を返す。
- native実装は現在ToolのAbortSignalを取得処理へ渡していない。Runtimeのキャンセルと既存30秒timeoutを両立させる。

**合意した限定的な挙動変更：** 取得・正規化はnative版を基準に統一する。PythonとTypeScriptの実装が完全に同等だったとは扱わない。少なくとも次を差分として検証し、移行文書へ残す。

- 更新日欠落時：Pythonは空文字、nativeは投稿日へfallbackする。
- ID欠落時：重複排除のkey／匿名entryの扱いが異なる。
- 引用符・backslash除去後のqueryの空白整形に差がある。

この統一はユーザー合意済みである。入口の引数検証・正常なJSON出力契約まで変更してよいという包括的な許可ではない。

### last30days

一括の検索・要約Toolへ作り直さず、現在どおり取得元ごとに独立して呼び、Skillが組み合わせる。HN／GitHubの直接curlを、Tool Proxy経由の限定された検索capabilityへ移す。公開APIで行っている処理に新しいcredential依存を追加しない。

| 取得元 | 維持する現行処理 |
| --- | --- |
| HackerNews | Algoliaの `/api/v1/search`。query、`tags=story`、`created_at_i` が30日前より新しい条件、10件。points／title／URL／comment数を利用 |
| GitHub | 公開の `/search/issues`。topicと `updated:>` の30日前の日時条件、`sort=reactions`、5件。reaction数／title／html_urlを利用 |
| Reddit | agent-reachによるReddit検索。`q`、`sort=top`、`t=month`、`limit=10` |

GitHubのコメントにはDiscussionsという表現があるが、実際のAPIはIssues／PRの検索である。Discussions APIへの置換や新しい検索機能を追加しない。Skill descriptionのYouTubeという語だけを理由に、新しいYouTube検索capabilityを実装しない。

HN／GitHub／Redditの出力、独立した取得・再試行の使い方、Skillの固定された日本語の集約見出しを維持する。汎用の任意URL／任意header付きHTTP capabilityへ置換しない。

### 今回移さないもの

- 天気、Tavily、既存GitHub Tool、Mail、Calendarのhost executor。
- 通常のAgent sandbox内のファイル操作、md2html、wiki／finance／session-logs等のローカル作業。
- RSS collectorやqueue／deliveryの設計。調査時点のRSS collectは `src/rss/feed.ts` の直接取得であり、過去のMemoryにあるagent-reach prefetchを前提に改修しない。
- Credential Proxyの認可機能追加。
- #399自身のnetwork firewall実装、#401の別設計の取り込み。

## セキュリティ上の前提と非目標

- 主目的はprompt injectionやAgentの誤判断から、許可していないnetwork／credential／host capabilityへ到達させないこと。
- Credential Proxyはsecret confidentialityとcredential injection／forwardingを担当する。provider／model／path／method認可、run token、approval、独自rate limitを追加しない。
- Capability認可はTool Proxyの責務とし、Runtimeを第二のrun authorization planeにしない。
- AgentにDocker socket、Runtime filesystem、hostの任意process実行を公開しない。
- 現在のRuntimeのpublic egress、private宛先制限、取得先URL／DNS／redirect検証、権限drop等の既存境界を維持する。使い捨てにしたことを理由にSSRF対策が不要になったとは考えない。
- composeにある公開DNS指定と、entrypointでfirewallを設定するための初期権限も単発launcherへ引き継ぐ。imageだけ起動して起動条件を落とさない。処理開始前の権限dropは維持する。
- parser／Chromium／container compromiseへの追加hardeningを主要設計ドライバにしない。#399／#401等のレビューを理由に、無関係なseccomp／AppArmor／SELinux／Landlock／mTLS等を追加しない。
- 許可されたcapabilityやinference自体を利用した情報送信まで禁止する計画ではない。新しいDLP／宛先承認／quota基盤は作らない。
- review指摘は、採用した境界で実在する問題か、今回不要な別の脅威モデルかを区別する。指摘を消すためだけに設計を広げない。

## 詳細実装計画を作るためのコード案内

以下は調査時点のmainへの参照。最新mainで対応箇所を確認すること。

| 責務 | 主な参照先と確認点 |
| --- | --- |
| Capability登録・派遣 | [registry.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/tools/registry.ts)、[capability.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/tools/capability.ts)。executor、factory、schema検証、default／clamp |
| Tool Proxy | [tool-proxy-server.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/proxy/tool-proxy-server.ts)。run snapshot、allowlist、approval、実行signal |
| Agent側のProxy frontend | [tool-proxy.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/tools/tool-proxy.ts)。結果envelopeと共通output boundary |
| run構成とcontainer管理 | [manager.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/agent/manager.ts)。native／Skillの別token、env／payload／revoke、既存Docker cleanup |
| Skill提示・設定検証 | [agent-runner.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/sandbox/agent-runner.ts)、[loader.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/skills/loader.ts)、[agent-validation.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/config/agent-validation.ts) |
| 現行Runtime | [agent-reach-runtime.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/runtime/agent-reach-runtime.ts)、[agent-reach-client.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/runtime/agent-reach-client.ts)、[agent-reach-capability.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/tools/agent-reach-capability.ts)。削除・一般化の起点 |
| agent-reachの実処理 | [agent-reach.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/tools/agent-reach.ts)、[exec.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/tools/exec.ts)。URL検証、Cookie、CLI、scratch、子process終了 |
| arXiv | [arxiv.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/tools/arxiv.ts)、[search.py](https://github.com/shin902/my-discord-agent/blob/52b5127/templates/SKILLS/arxiv-search/scripts/search.py)、[survey.py](https://github.com/shin902/my-discord-agent/blob/52b5127/templates/SKILLS/arxiv-survey/scripts/survey.py) |
| last30days | [SKILL.md](https://github.com/shin902/my-discord-agent/blob/52b5127/templates/SKILLS/last30days/SKILL.md)、[reddit-search.sh](https://github.com/shin902/my-discord-agent/blob/52b5127/templates/SKILLS/last30days/scripts/reddit-search.sh) |
| 大きな結果 | [output.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/tools/output.ts)。Agent側で50,000文字超を外部化する現行境界 |
| Reddit maintenance | [reddit-cookie-refresh-client.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/runtime/reddit-cookie-refresh-client.ts)、`src/proxy/reddit-cookie-refresh.ts`、`src/cron/jobs/reddit-cookie-refresh.ts`、`scripts/reddit-cookie-refresh.ts`、`scripts/reddit-cookie-login.ts` |
| image・起動 | [Dockerfile.tool-runtime](https://github.com/shin902/my-discord-agent/blob/52b5127/Dockerfile.tool-runtime)、[entrypoint](https://github.com/shin902/my-discord-agent/blob/52b5127/scripts/tool-runtime-entrypoint.sh)、[compose.tool-runtime.yaml](https://github.com/shin902/my-discord-agent/blob/52b5127/compose.tool-runtime.yaml)、`package.json`、`.env.example` |
| 既存Skillの配布 | [group-config.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/config/group-config.ts)。既存Skillはテンプレートから自動上書きされない |
| host起動・終了 | [index.ts](https://github.com/shin902/my-discord-agent/blob/52b5127/src/index.ts)。進行中Runtimeの終了／残存container処理との接続点を確認 |

参照する既存文書は `AGENTS.md`、`docs/proxy.md`、`docs/agent-tools-skills.md`、`docs/spec/agent-reach-tool-runtime.md`、`docs/guides/reddit-cookie-setup.md`、`docs/security-tradeoffs.md`、`docs/sandbox-command.md`。現行仕様と本Issueが意図して変更する箇所を混同しない。

## 推奨する実装・検証の分割

順序は変更してよいが、各段階で実際の呼び出し経路を通し、最後に接続するためだけの仮frameworkを先に作らない。

1. **契約の確認**：最新main・#399・既存testを確認し、RegistryでのRuntime指定、共有authorityの解決、単発containerの入出力・終了責務を具体化する。追加する関数／ファイルと削除する特殊処理を対にして計画する。
2. **agent-reachの使い捨て実行**：既存のcore処理を通して、host起動→Runtime処理→結果→破棄の経路を完成させる。Reddit未設定と、通常のAgent sandboxに揃えた終了・abort／timeout・次回起動時のlabel cleanupを検証する。
3. **共通の権限とCLI**：一つのrun token、trustedなSkill依存解決、共通CLIを実装する。既存のnative Tool／Skill提示・stdoutと設定済みapprovalを維持し、専用token・通信処理を削除する。
4. **arXivとlast30days**：取得／parserをRuntimeへ移し、入力・出力・検索条件をfixtureで比較する。arXiv正規化統一の差分を明示する。HN／GitHubは新しい限定検索capabilityとして同じ登録・実行経路を使う。
5. **maintenanceと運用移行**：Reddit更新を単発実行へ移し、古い常駐service／env／composeの扱い、image準備、既存groupのSkill更新、hostとRunnerの更新手順を整える。
6. **#399との組合せと自己レビュー**：共通権限だけでdirect egress閉鎖後も動作することを確認する。不要な抽象化・互換layer・特殊token・重複定義を削る。approvalの条件付き拡張は複雑化するなら外す。

## 必須の受け入れ条件

### 権限・設定・提示

- [ ] native ToolとSkill CLIが同じrun token／capability認可を使う。専用agent-reach／last30days token発行を残さない。
- [ ] Toolだけ選択・Skillだけ選択・両方選択・両方非選択・`skills: "*"` の各caseを検証する。
- [ ] Toolだけ選択したcapabilityは、同名Skillが非選択でもCLIから呼べる。未許可capabilityと期限切れ／revoke済みtokenは拒否される。
- [ ] wildcardは既知Skill依存へだけ展開され、他の高権限capabilityをまとめて許可しない。Skill本文を書き換えても任意の権限宣言を追加できない。
- [ ] native schemaとSkill説明の提示条件、および明示的なSkill呼び出しの選択チェックを維持する。
- [ ] 設定済みapprovalは入口を問わず適用され、表示・承認した実効引数と実行引数が一致する。
- [ ] Skill単独capabilityをapproval指定可能にする拡張の採用／見送りと理由を報告する。見送りは未完了扱いにしない。

### Runtime・ファイル・認証情報

- [ ] Tool callごとにcontainerが分離され、通常終了・処理エラーで `--rm` により削除される。
- [ ] abort／timeoutではそのcallの正確なcontainerをkillする。Docker CLIだけを停止する処理にしない。run revokeとhostの通常shutdownも同じ中断経路へ接続する。
- [ ] host crash後は次回起動時にTool Runtime専用labelのcontainerだけcleanupし、Agent sandboxや他serviceを対象にしない。
- [ ] 実際の子processを使うテストで、終了したTool callの処理が走り続けないことを確認する。
- [ ] RuntimeにAgent workspaceや任意host pathを公開せず、Runtime内pathを結果として返さない。
- [ ] scratch・大きいnative結果・Skillのstdout／redirection・Agentの明示保存の寿命を維持する。
- [ ] Reddit未設定で非Reddit機能が動く。Reddit取得とmaintenanceは既存stateを利用し、container破棄でstateを消さない。
- [ ] maintenanceをAgent向けに公開せず、Cookieを結果やAgent環境へ渡さない。
- [ ] Runtime HTTP入口と不要になったservice／maintenance tokenが残らない。Tool Proxyの認可境界は残る。

### 機能・組合せ

- [ ] agent-reachの対応サービス、URL／error境界、取得結果を既存fixtureで検証する。
- [ ] arXivのnative／CLI入力契約とJSON出力を検証し、合意した正規化差分を記録する。
- [ ] last30daysのHN／GitHub／Redditが独立して動き、検索条件・表示項目・最終出力の見出しを維持する。
- [ ] #399と組み合わせた実Agent sandbox→Tool Proxy→使い捨てRuntimeの経路で対象機能が動く。Agent側の直接Internet通信を再許可して通さない。
- [ ] 今回移さない既存host Tool、Credential Proxy、queue／deliveryの境界を変更していない。
- [ ] 既存groupへ配置されたSkillも更新する具体的な手順があり、テンプレートだけ更新して完了にしない。

## テストと安全な検証方法

既存の `src/tools/registry.test.ts`、`src/tools/tool-proxy.test.ts`、`src/proxy/tool-proxy-server.test.ts`、`src/config/agent-validation.test.ts`、`src/agent/manager.test.ts` を権限・設定・呼び出しの回帰検証に使う。

Runtimeの `src/runtime/agent-reach-runtime*.test.ts`、`src/runtime/tool-runtime-entrypoint.test.ts`、Reddit refreshのclient／script testを、単発containerの実際の契約へ更新する。HTTP endpointを廃止するのに、HTTP testを通すためだけの旧serverや互換clientを残さない。

agent-reachのtemp／shell／cookie／security testと `src/tools/arxiv.test.ts` を利用する。arXivにはPython CLIとnativeの比較fixtureを追加し、last30daysには固定の上流responseによる検索条件・整形検証を用意する。

実Dockerの検証を含める。公開APIの揺れだけでCIが失敗しないよう、成功応答・失敗応答を制御できるfixtureを基本にする。live smokeを行う場合は対象と結果を別に報告し、本番Cookieや本番maintenanceを試験fixtureとして使わない。#399の現行network integration testにはRuntime HTTPを模したfixtureがあるため、新構成の実経路を検証しているか確認する。

`AGENTS.md` に従い、Biome対応ファイル編集後は当該ファイルへ直ちに `pnpm exec biome check --write <changed-file>` を実行する。実装完了前には以下を実施する。

```sh
pnpm format:check
pnpm lint
pnpm typecheck
DOTENV_CONFIG_PATH=/dev/null pnpm test
pnpm build:runner
pnpm build:tool-runtime
```

image buildとRuntime／#399の実Docker testも変更に合わせて実施する。調査時点では既存のReddit refresh testがローカル `.env` を読むと実serviceへ接続し得るため、通常testではdotenv読込先を空にして本番設定から分離する。これはテスト時の措置であり、通常運用の認証設定を変更する指示ではない。

計画作成とコード調査だけでは、これらのテストに合格したことにはならない。最終報告では実施済み／未実施／環境上実施できなかったものを区別する。

## PRと導入の順序

1. 最新mainからTool Runtime用の別ブランチを作り、本Issueの実装を独立PRにする。
2. 検証用に#399と組み合わせ、direct egress閉鎖後の動作を確認する。#399をbaseにして変更を戻し、同PRへRuntime移行を押し込む方法は採らない。
3. Tool Runtime PRを先にmainへマージする。
4. #399を更新後のmainへrebaseし、実経路のtestと説明を更新して再検証する。
5. 導入環境でRuntime image・hostアプリ・Runner image・対象の配置済みSkillの更新が揃った後、#399の閉鎖を導入する。

運用手順には少なくとも以下を含める。

- 常駐Runtime用compose／serviceの停止と、新しいimageの事前build方法。
- 廃止される `AGENT_REACH_RUNTIME_URL`／`AGENT_REACH_RUNTIME_TOKEN`／`AGENT_REACH_REFRESH_TOKEN`、およびSkill専用envの扱い。
- host側の共通image設定等を追加した場合の設定場所と反映手順。不要なら設定項目を増やさない。
- Redditの既存profile／Cookieを保持したまま、初回login・単発refreshを利用する方法。
- `groups/*/SKILLS/` 内の既存script／手順の更新方法。カスタマイズを無条件に上書きせず、差分を確認して共通CLIを利用する内容へ更新する。
- Runtime imageや共通CLIの不足を、旧直接Internet経路へのfallbackで隠さず診断できること。

このIssue作成時点では、新しいPRの作成・merge・本番更新は未実施である。

## 採用しない案と理由

| 案 | 採用しない理由 |
| --- | --- |
| agent-reach専用Runtimeを改名するだけ | 複数capability、専用token、Reddit起動依存、Skill重複が残る |
| ToolごとのRuntime／token／通信経路 | 現在の特殊処理を複製して増殖させる |
| 常駐Runtime／Agent run単位の共有Runtime | ユーザーはTool call単位の破棄を選択。起動費用と引き換えに共有状態・所有関係・呼び出し管理を減らす |
| callごとのHTTP Runtime | 使い捨てでもport発見・readiness・service認証が必要になり、stdin/stdoutより複雑 |
| tokenなしで旧Runtime HTTPを残す | 入口廃止とは異なり、Tool Proxyを迂回する経路を残す |
| Skillからの利用をnative Tool選択だけに限定 | Skill単独利用とCLI／stdoutの既存利用を崩す |
| ToolとSkillの別authorityを維持 | 同じcapabilityを入口で分ける必要がなく、専用処理とapprovalの不一致が残る |
| shared volume／汎用artifact API | 今回の機能は結果本文で受け渡せる。新しいファイル共有契約が不要 |
| 全host APIをRuntimeへ移す | 今回の対象としてユーザーが明示的に却下した |
| dynamic plugin、任意script実行、汎用job／pool | 現在の対象に必要な機能ではなく、追加の設定・寿命・認可の契約を生む |

## 実装担当者による最終確認

実装後は自分の案を敵対的に再確認し、次を説明すること。

- 既存capabilityの選択が、意図せず別のcapabilityやmaintenanceを許可していないか。
- Agentに公開したCLIから、実行先・mount・任意host処理を選べないか。
- token共通化で設定済みapprovalの迂回を作っていないか。
- 使い捨てと説明しながら、失敗・キャンセル後のcontainerや子processを残していないか。
- arXiv／last30daysの表面上の成功だけで、検索条件・stdout・既存配置の移行を落としていないか。
- 削除した専用処理より大きいframeworkや重複Registryを作っていないか。
- 今回の目的と関係のないhardeningや、条件付きapproval拡張のための複雑性を追加していないか。

最終報告には、採用設計、非採用案の理由、実装範囲、意図した変更、残した課題、検証結果、導入条件を記載する。条件付きapproval拡張を見送った場合は、追加hardeningで無理に成立させず、その判断を報告する。
