# Issue #404: GPT-6 Astra 有効化 実装計画

## 目的

Pi SDK 0.85.1 が持つ GPT-6 Astra の built-in model metadata をそのまま使い、次の2経路を設定可能にする。

1. `openai / gpt-6-astra` → Credential Proxy → OpenAI Responses API
2. `openai-codex / gpt-6-astra` → Credential Proxy → CLIProxyAPI `/v1/responses` → Codex backend

主な実利用経路は2とする。1は設定可能にするが、有料のOpenAI API smokeは行わない。2だけをmy-discord-agentのAgent loopから実機smokeし、結果をIssue #404のコメントへ残す。

この変更ではAstra専用metadata、provider abstraction、Codex OAuth処理、protocol変換、fallback、migrationを追加しない。`forceCustom`機能自体の削除はIssue #524の責務であり、本Issueでは実施しない。

## 実装前に固定して扱う事実

### 現行依存とPi API

- `package.json` は `@earendil-works/pi-ai` と `@earendil-works/pi-agent-core` をともに `0.85.1` へ固定済み。
- `@earendil-works/pi-ai/compat` の `getModels(provider)` が返すcatalogには、`openai` と `openai-codex` の両方で以下が存在する。
  - `gpt-6-astra`
  - `gpt-5.6-sol`
  - `gpt-5.6-luna`
  - `gpt-5.6-terra`
- `src/agent/model.ts` の `resolveModel()` はKnown ProviderについてPiのbuilt-in modelを解決し、credential entryから `baseUrl` と明示された `api` だけを上書きする。metadata保持とwire API overrideは実装済みなので変更しない。
- Pi 0.85.1の `ModelThinkingLevel` は `max` を許容する。my-discord-agent側の `src/config/groups.ts` にある `THINKING_LEVELS` だけが未対応。

実装前の再確認コマンド:

```bash
node --input-type=module <<'NODE'
import { getModels } from "@earendil-works/pi-ai/compat";

for (const provider of ["openai", "openai-codex"]) {
  const modelIds = getModels(provider)
    .filter(({ id }) => /gpt-(6-astra|5\.6-(sol|luna|terra))/.test(id))
    .map(({ id }) => id);
  console.log(provider, modelIds);
}
NODE
```

ここでAstraが見つからない場合は実装を進めず、lockfile/install状態とIssueの前提の不一致として報告する。Astraをアプリ側へ手書きして回避してはならない。

### 現在インストール済みバージョンで利用するAPIと一次情報

| 用途 | 正しい利用方法 | 一次情報 |
|---|---|---|
| Pi catalog参照 | 既存コードどおり `import { getModels } from "@earendil-works/pi-ai/compat"`。実装へ新しいcatalog呼び出しは追加せず、事前確認だけに使う | [Pi v0.85.1 compat entrypoint](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/compat.ts), [providers/all.ts](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/providers/all.ts), [npm 0.85.1](https://www.npmjs.com/package/@earendil-works/pi-ai/v/0.85.1) |
| thinking level型 | `import type { ModelThinkingLevel } from "@earendil-works/pi-ai"` を維持し、既存tupleへ文字列リテラル `"max"` を追加する | [Pi v0.85.1 types.ts](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/types.ts) |
| OpenAI Responses adapter | OpenAIはbuilt-inの `openai-responses` を使用。Codex経路はmodel identityを `openai-codex` のまま保ち、credential entryの `api: "openai-responses"` でwire APIだけ上書きする | [Pi v0.85.1 openai-responses.ts](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/api/openai-responses.ts), [openai-codex provider](https://github.com/earendil-works/pi/blob/v0.85.1/packages/ai/src/providers/openai-codex.ts) |
| CLIProxyAPI | `v7.2.155` のrelease assetを使う。`cli-proxy-api --help` の先頭に `CLIProxyAPI Version: 7.2.155` が出る。OAuth loginは `-codex-login`、headlessは `-codex-device-login` | [CLIProxyAPI v7.2.155 release](https://github.com/router-for-me/CLIProxyAPI/releases/tag/v7.2.155), [v7.2.155 README](https://github.com/router-for-me/CLIProxyAPI/blob/v7.2.155/README.md), [Astra追加commit c77b136](https://github.com/router-for-me/CLIProxyAPI/commit/c77b13694318b0897f2c74104ef48aebdf8c34d6) |

CLIProxyAPIのrelease assetはOS/architectureに合うものをreleaseページから取得する。package managerの最新版を検証済みversionとして扱わない。インストール後は必ず次を実行し、先頭行が `7.2.155` であることを確認する。

```bash
cli-proxy-api --help 2>&1 | head -1
```

## 変更対象ファイル

### 1. `src/config/groups.ts`

`THINKING_LEVELS` の末尾へ `"max"` を追加する。それ以外のschema、provider別分岐、Astra固有validationは追加しない。

変更後の配列:

```ts
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly [ModelThinkingLevel, ...ModelThinkingLevel[]];
```

Piの型が正本なので、別のmapping定数やAstra判定関数は作らない。

### 2. `src/config/groups.test.ts`

`describe("loadGroups")` 内へ1ケースだけ追加する。テスト名は仕様を表す `thinkingLevel: max のモデル設定を読み込める` とする。

入力は最小のgroup設定に以下を含める。

```ts
model: {
  provider: "openai-codex",
  modelId: "gpt-6-astra",
  thinkingLevel: "max",
}
```

`loadGroups()` の結果に同じmodel設定が保持されることを1回だけ検証する。Astra catalog、SSE、tool continuation、model resolutionの重複fixtureは追加しない。

### 3. `config/credentials.example.json`

次の2点だけ変更する。

1. `provider: "openai"` entryから `forceCustom: true` を削除する。これによりPiのOpenAI built-in catalogが使われ、Astra/Sol/Luna/Terraのmetadataと `openai-responses` が保持される。
2. 旧 `codex-oauth` custom entryを次へ置換する。

```json
{
  "provider": "openai-codex",
  "envVars": ["CLIPROXY_API_KEY"],
  "baseUrl": "http://localhost:8317/v1",
  "api": "openai-responses"
}
```

旧entryの `forceCustom`、`contextWindow`、`maxTokens` は削除する。Pi catalogと重複するmetadataを設定へ移さない。他providerの `forceCustom` やChat Completions設定は触らない。

### 4. `config/providers.example.json`

`provider: "codex-oauth"` を `provider: "openai-codex"` へ変更し、`concurrency: "parallel"` は維持する。他providerのresource/concurrencyは変更しない。

### 5. `docs/config.md`

`config/providers.json` と `config/credentials.json` の例を現行名称へ更新する。

- `codex-oauth` → `openai-codex`
- Codex credential exampleから `forceCustom`、`contextWindow`、`maxTokens` を削除
- OpenAI built-in routeの例を示す場合は `forceCustom` を付けない
- Codex経路ではmodel identityが `openai-codex`、wire APIが `openai-responses`、gatewayがCLIProxyAPIであることを短く記載
- `thinkingLevel` の説明へ `max` が共通AgentConfigで許容されることを追加し、意味・mappingはPi metadataへ委譲すると記載

既存のMemoryCore向けCLIProxyAPI記述は本Issueと無関係なので変更しない。

### 6. `docs/config/credential-proxy.md`

現行のmodel resolution契約は正しいため、構造を書き換えない。次だけ整合させる。

- built-in OpenAI routeでは `forceCustom` を指定しないことを明記
- `compat.thinkingLevelMap` の許容キー説明に `max` を追加する必要はない。現行schema `src/config/credential-proxy.ts` はcustom provider mapで `max` を受理しないためであり、本Issueではそのschemaを変更しない
- AgentConfigの `thinkingLevel` 説明には `max` を含め、built-in modelのmappingをPiへ委譲することを明記
- CLIProxyAPI例は専用ガイドへのリンクに集約し、設定を重複させない

### 7. `docs/guides/codex-oauth-cliproxyapi.md`

このファイルを運用手順の正本として更新する。

#### versionとhostインストール

- 検証済みversionを `v7.2.155` と明記
- GitHub release assetからOS/architectureに合うarchiveを取得する方法を示す
- `cli-proxy-api --help 2>&1 | head -1` でversionを確認する
- 設定ファイルを `~/.cli-proxy-api/config.yaml` に固定し、OAuth login、device login、server起動の全コマンドで `-config "$HOME/.cli-proxy-api/config.yaml"` を明示する
- `latest`、`v1.x.x` のプレースホルダーを検証済み例として残さない
- host運用をAstraの推奨経路とする
- 新しいDocker/Composeファイルは追加しない。既存の一般的なDocker参考節は残してよいが、Astraの検証済みhost手順と混同させない

#### credential/model設定

- custom `codex-oauth` entryを削除し、`openai-codex` + `api: "openai-responses"` の例だけを掲載
- group model例を `openai-codex / gpt-6-astra / thinkingLevel: max` へ更新
- `CLIPROXY_API_KEY` 未設定時の説明もprovider名を `openai-codex` へ更新
- OpenAI API key経路は設定可能だが、有料smokeは本Issueでは行わないと明記

#### 接続先

- Credential Proxyをhost processとして起動する標準構成: `http://localhost:8317/v1`
- Credential Proxy自体がCLIProxyAPIと同じDocker network内にいる既存構成だけ: `http://cli-proxy-api:8317/v1`
- sandbox containerからCLIProxyAPIへ直接接続させない
- host processからDocker内部DNS名を使わない

#### smoke

直接curlだけを完了条件にしない。実際の経路 `Agent loop → Credential Proxy → CLIProxyAPI → Codex backend` で行う手順と、Issueコメントへ残す証跡項目を記載する。

### 8. `docs/spec/provider-concurrency.md`

歴史的資料であることは維持し、例中のprovider名だけ `codex-oauth` から `openai-codex` へ変更する。設計本文の再構成はしない。

### 9. `docs/prompts/url-codex.md`

冒頭の「codex-oauth 系モデル」を「openai-codex 系モデル」へ変更する。personaやprompt本文は変更しない。

## 明示的に変更しないファイル

- `src/agent/model.ts`: built-in metadata保持とroute/wire overrideは実装済み。
- `src/proxy/credential-proxy-server.ts`: transparent forwardingとhost credential差し替えは実装済み。Codex固有処理を追加しない。
- `src/config/credential-proxy.ts`: `forceCustom`削除は#524。custom `thinkingLevelMap`への `max` 追加も本Issueの要件ではない。
- `src/agent/model.test.ts` / `src/proxy/provider-auth.integration.test.ts`: 対象経路の既存テストをAstra名で重複させない。
- `config/groups.example.json`: repositoryの標準groupをAstraへ切り替えない。smoke用model設定はgitignoredの実設定で一時的に行う。
- `config/config.example.json`: default modelは変更しない。
- `config/credentials.json` / `config/providers.json` / `config/groups.json`: gitignoredの実運用設定。実装差分へ含めず、smoke時だけ運用者が更新する。
- `docs/proxy.md`: `Codex OAuth` は認証方式の概念名として正しい。provider identifier `codex-oauth` と混同して一括置換しない。
- `src/config/providers.test.ts`、`src/config/credential-proxy.test.ts`、`src/queue/poller.test.ts` 等の任意provider名fixture: ユーザー向け設定例ではないため変更しない。

## 実装順序

1. Issue #404本文・コメントを再取得し、要件変更がないことを確認する。
2. Pi catalog確認コマンドを実行し、Astra/Sol/Luna/Terraが両providerに存在することを確認する。
3. `src/config/groups.ts` と `src/config/groups.test.ts` を変更する。
4. 直ちに `pnpm exec biome check --write src/config/groups.ts src/config/groups.test.ts` を実行する。
5. `config/credentials.example.json` と `config/providers.example.json` を変更する。
6. 直ちに `pnpm exec biome check --write config/credentials.example.json config/providers.example.json` を実行する。
7. 対象ドキュメントを更新する。
8. `rg -n 'codex-oauth' config docs src` を実行し、残件を分類する。ユーザー向けprovider identifierはゼロにし、認証方式としての「Codex OAuth」と汎用test fixtureだけを残す。
9. focused testと品質管理を実行する。
10. host上のCLIProxyAPI v7.2.155とgitignored実設定を用意し、ブラウザからDiscord smokeを行う。
11. smoke結果をIssue #404へコメントする。秘密値、token、credentialを含めない。

## テスト方針

### 自動テスト

唯一の新規ケース:

- 配置: `src/config/groups.test.ts`
- 対象: `ModelConfigSchema`を共有するgroup設定のparse
- 観点: `thinkingLevel: "max"` が拒否されず、load後も保持される

focused test:

```bash
pnpm exec vitest run src/config/groups.test.ts
```

追加しないテスト:

- Astra metadataのコピー比較
- Astra名だけを使うmodel resolution test
- fake SSE test
- fake tool continuation test
- OpenAI API smoke
- `forceCustom` migration test

既存の `src/agent/model.test.ts` と `src/proxy/provider-auth.integration.test.ts` がmetadata保持、wire API override、host credential差し替え、Codex固有header非生成を担うため、重複させない。

### 設定・文書の静的確認

```bash
rg -n 'codex-oauth' config docs src
rg -n 'gpt-6-astra|openai-codex|thinkingLevel.*max|v7\.2\.155' \
  config/credentials.example.json \
  config/providers.example.json \
  docs/config.md \
  docs/config/credential-proxy.md \
  docs/guides/codex-oauth-cliproxyapi.md \
  docs/spec/provider-concurrency.md \
  docs/prompts/url-codex.md
```

残る `codex-oauth` が概念名または汎用fixtureかを1件ずつ確認する。機械的一括置換はしない。

## 品質管理

`CLAUDE.md` は `AGENTS.md` を正本として参照している。以下を順番に実行する。

### 編集直後

Biome対応ファイルを編集した直後に対象ファイルだけ整形・lintする。

```bash
pnpm exec biome check --write src/config/groups.ts src/config/groups.test.ts
pnpm exec biome check --write config/credentials.example.json config/providers.example.json
```

### 提出前の必須チェック

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

### buildとCI整合

```bash
pnpm build
pnpm build:tool-runtime
pnpm build:runner
```

GitHub ActionsではさらにTool Runtime image、Agent Runner image、Playwright Chromiumを用いたgallery smokeを実行する。ローカルでDockerが利用可能なら `.github/workflows/ci.yml` と同じimage buildも確認する。利用できない場合は省略を明記し、PRのCI結果で確認する。

失敗した場合は今回の差分によるものかを切り分け、修正して全必須チェックを再実行する。

## ブラウザでの動作確認（Discord実機smoke）

このIssueにWeb UI実装はないため、ブラウザ確認対象はDiscord Web上の実Agent応答とGitHub Issueの証跡である。OpenAI API key経路は実行しない。

### 事前準備

1. `pwd` と `git rev-parse HEAD` を記録する。
2. 既存my-discord-agentプロセスがある場合、`lsof` とプロセス情報で実行cwdを確認する。別worktreeのプロセスなら停止し、このworktreeから起動する。
3. `pnpm build:runner` と通常のrunner image更新手順を実行し、古いbundle/imageを使わない。
4. hostにCLIProxyAPI v7.2.155を配置し、`cli-proxy-api --help 2>&1 | head -1` でversionを確認する。
5. 設定を `~/.cli-proxy-api/config.yaml` に保存する。OAuth loginは `cli-proxy-api -config "$HOME/.cli-proxy-api/config.yaml" -codex-login`、headless環境は同じ `-config` と `-codex-device-login` を使う。
6. `cli-proxy-api -config "$HOME/.cli-proxy-api/config.yaml"` で、設定したhostのloopback `127.0.0.1:8317` にserverを起動する。loginとserverで同じ設定ファイルを必ず指定する。
7. `.env` の `CLIPROXY_API_KEY` とCLIProxyAPIの `api-keys` を一致させる。値はログ、Issue、スクリーンショットへ出さない。
8. gitignoredの `config/credentials.json` に `openai-codex` entryを設定する。
9. gitignoredの `config/providers.json` で `openai-codex` を `parallel` に設定する。
10. smoke対象groupまたはchannelの実設定を次へ変更する。tool continuation確認用に、その設定階層で `bash` toolを許可する。

```json
{
  "model": {
    "provider": "openai-codex",
    "modelId": "gpt-6-astra",
    "thinkingLevel": "max"
  }
}
```

11. このworktreeからmy-discord-agentを起動する。起動ログでmodel validation、Credential Proxy起動、Discord loginが成功し、CLIProxyAPI接続先がhostから到達可能であることを確認する。

### ブラウザ操作と期待結果

1. ブラウザでDiscord Webを開き、smoke対象channelへ移動する。
2. basic response確認として、Botへ「`ASTRA_SMOKE_OK` とだけ返してください」と送信する。
   - 期待結果: エラーや途中切断なしに `ASTRA_SMOKE_OK` が返る。
   - SSE確認: server/agentログでstreamがterminal eventまで完了し、Discord応答が欠落・重複していない。
3. tool continuation確認として、Botへ「bashツールで `printf ASTRA_TOOL_OK` を実行し、その出力をそのまま返してください」と送信する。
   - 期待結果: bash tool callが1回実行され、tool resultを受けた継続推論の最終応答に `ASTRA_TOOL_OK` が含まれる。
   - sandbox内のcommandだけを使い、host filesystemをmountして確認しない。
4. ログを確認する。
   - upstreamはCredential Proxy経由のCLIProxyAPI `/v1/responses`。
   - model identityは `openai-codex / gpt-6-astra`。
   - thinking levelは `max`。
   - `ChatGPT-Account-Id`生成、Codex JWT decode、OpenAI APIへのfallbackが発生していない。
5. ブラウザでGitHub Issue #404を開き、次だけをコメントする。
   - 実施日
   - `git rev-parse HEAD` のcommit
   - CLIProxyAPI version
   - `openai-codex / gpt-6-astra / max`
   - basic response / SSE / tool continuation / baseUrl到達性の成否
   - 失敗時はcredentialを除いたエラー概要
6. smoke用に変更したgitignored実設定を、必要に応じて通常運用設定へ戻す。

## 完了時セルフチェック

- [ ] 変更対象として記載した全pathが存在する。
- [ ] 新規ファイルはこの実装計画以外にない。
- [ ] `THINKING_LEVELS` へ `max` だけを追加した。
- [ ] 新規自動テストはgroups validationの1件だけ。
- [ ] OpenAI exampleはPi built-in解決を使う。
- [ ] Codex exampleは `openai-codex` identity + `openai-responses` wire APIを使う。
- [ ] user-facingな `codex-oauth` provider identifierが残っていない。
- [ ] 汎用fixtureと認証方式としての「Codex OAuth」を不用意に変更していない。
- [ ] `forceCustom`機能本体、Credential Proxy、Agent loopを変更していない。
- [ ] CLIProxyAPI v7.2.155のhost手順と到達可能なbaseUrlを記載した。
- [ ] 全品質チェックが成功した。
- [ ] Discord Web smokeが成功し、Issue #404コメントへ証跡を残した。
