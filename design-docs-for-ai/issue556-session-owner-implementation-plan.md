# #556 Session owner 実装計画

対象: https://github.com/shin902/my-discord-agent/issues/556 （本文・コメントを `gh issue view 556 --json title,body,comments` で確認。コメントは0件）。後続のMemory処理は #557。**本計画ではMemory export、snapshot/revision、context注入、MemoryCoreは変更しない。**

## 現状と完成条件

- `src/agent/session.ts` はgroupごとの `data/sessions/<group>/sessions.sqlite` を管理する。現行schema v4の `sessions(id,kind,created_at,updated_at)` にはownerがなく、最初の `appendMessage()` がsessionを作成する。`renameSession()` はIDを書き換え、entryはFKの `ON UPDATE CASCADE` で追随する。`loadMessages()` は指定sessionのentryをsequence順で返す。
- `src/queue/bot-task-sessions.ts` の `prepareBotTaskSession()` が `bot-task-<UUID>` のsessionにrole snapshotを**先に**保存し、その後 `src/queue/repository.ts` がruntime DBの `bot_task_sessions(group_name,session_id,bot_id,...)` に登録する。直接Bot経路は `src/agent/bot-orchestration.ts`、Discord経路は `src/application/discord-command-service.ts`。失敗・重複した準備で、runtime DBに登録されないBot sessionが残り得る。
- `src/sandbox/agent-runner.ts`、`src/sandbox/session-bootstrap.ts`、`src/discord/intake.ts` 等も `appendMessage()` を呼ぶ。Botの実行時は既に作成済みのsessionに追記する。後続の追記がMain ownerへ**上書きしない**ことが重要。`src/queue/delivery.ts` は通常sessionをrenameする。
- 完成後は各sessionに不変の `agent_id`（**新規カラム**）があり、`group + agent_id` を指定してsession trajectoryを読む共通経路を使える。Mainの予約IDは `main`。Bot ID `main` を設定できない。同group内・group間とも別ownerのsessionを混ぜない。

## 変更対象と順序

1. **`src/agent/session.ts`**: `SCHEMA_VERSION` を5にする。新規DB作成の `sessions` に `agent_id TEXT NOT NULL`（**新規**）とowner絞り込みindexを定義。新コードのschema初期化は「空DBのv5作成」と「v5の既存DB利用」のみを扱い、v4のruntime自動backfillはしない。v4以前のDBに新コードを当てる前に下記の停止・移行を必須にする。既存の一般的な未対応schemaエラーで十分で、移行用の専用エラー分岐は不要。
   - `appendMessage()` に新規session作成時のownerを指定可能にする（既存の第4引数 `source?: SessionSource` は破壊しない。例えば第5引数にownerを追加し、省略時は `main`）。INSERT時だけownerを使い、既存sessionとの `ON CONFLICT(id)` では従来どおり更新時刻だけ更新し、ownerを変更しない。source provenance重複時の既存ID返却も維持。後続追記、bootstrap、steering等がownerを推測・付け替えない構成にする。
   - **新規API** `readOwnerSessions(groupName, agentId)` 等を用意し、該当ownerのsession IDとentry payloadをsession内のsequence順に取得可能にする。実装はgroup DBの `sessions.agent_id` に対する条件付き読出し。`readConversations()` と同様、読み取り側ではDBやmigrationを作らず、既存の `parseStoredMessage()` でtrajectoryを復元する。sessionを跨ぐ安定した順序と、呼び出し側が全件を一括ロードする必要のない走査方法を定める。既存 `loadMessages()` と `readConversations()` の用途・採用参照の意味は変えない。
2. **`src/queue/bot-task-sessions.ts`**: `prepareBotTaskSession()` の最初のsnapshot保存で、すでに入力にある `input.botId` を `appendMessage()` に渡しownerを確定。`loadBotTaskSystemPrompt()` 等のresumeはowner変更を行わない。これ以降のBot実行は既存sessionへの追記なので、runner側にBot判定やruntime DB照会を追加しない。
3. **`src/config/bots.ts`**: Bot registryのvalidationで予約ID `main` を禁止する（Botが既存設定から削除されても、保存済みownerには影響させない）。`src/config/bots.test.ts` に拒否ケースを追加。Discord bot定義の `config/config.json` とは別のBot registryであることに注意。
4. **`scripts/convert-issue556-session-owners.ts`（新規）**: operatorがruntime停止・バックアップ後に一度だけ実行するオフライン変換。引数でruntime DBとsession DB rootを明示させ、実環境を暗黙に決めない。session root配下の実在する `sessions.sqlite` だけを列挙し、変更開始前に全対象の `PRAGMA user_version` が4であることを確認（未作成のgroup DBを新たに作らない）。runtime DBの `bot_task_sessions` を `group_name + session_id` で参照し、group DBごとに1 transactionで `sessions.agent_id` を追加・Bot ownerを更新・未登録の**現行生成形式 `bot-task-<UUID>` に一致するsessionだけ**を削除し、v5にする。それ以外は `main`。登録済みBotのIDは現行registryに無くても保持する。各group DB接続で `PRAGMA foreign_keys = ON` を有効にし、`session_entries` は既存FKの `ON DELETE CASCADE` で残骸に対応させる。通常sessionのentries/source/IDsは保持する。途中失敗時は停止状態を維持してバックアップから復元してから再実行する手順にする（複数group間のatomicityは仮定しない）。runtime DBのqueue・admission・deliveryは書き換えない。サービス停止コマンド、常駐migration、v1〜v3変換、特別な復旧frameworkは実装しない。
5. **`scripts/convert-issue556-session-owners.test.ts`（新規）**, **`src/agent/session.test.ts`**, **`src/agent/bot-task-session.integration.test.ts`**: 下記のテストを追加・既存v4期待値を更新。必要なら `src/queue/bot-task-sessions.test.ts` も、Bot準備時のowner確認に限って追加する。旧schemaの自動migrationを期待する既存の `src/agent/session.test.ts` のテストは、新しい停止・手動移行契約に合わせて変更し、run-timeがv4を暗黙に上げることを期待しない。
6. **`docs/storage.md` と `docs/spec/entity-model.md`**: session ownerの正本・scope・移行順序・バックアップ・再起動条件を反映。`docs/agent-memory.md` はMemoryの動作を変更しないので、既存記述が矛盾する場合だけ最小限修正する。`README.md` / example configは実際のoperator導線・設定変更が必要な場合だけ更新する（`.pi/skills/update-docs/SKILL.md`）。

## 移行と危険箇所

- 実装開始時に**確認可能な**group DBのschema versionをread-onlyで確認する。現時点のコードはv4だが、実運用DBにv1〜v3が見つかった場合は本計画を無断で拡張せず、Issueに沿ってオーナーへ扱いを確認する。repoのクローンに実運用DBがない場合はその事実を記録し、運用前のversion確認を導入手順の必須条件として残す。旧版対応を勝手に足さない。
- runtimeを停止、runtime DBとすべてのgroup session DBをSQLite整合バックアップ（WALを含む）し、変換スクリプトを実行、件数・owner・削除候補を確認、その後同じcheckoutで `pnpm build` して新host/runner imageを揃えて起動する。スクリプトから起動・停止はしない。新runtimeを未変換DBと同時起動しない。
- 既存Bot Taskの照合は移行時だけ。`bot_task_sessions` に無い `bot-task-<UUID>` はsession作成後に登録に失敗した残骸として削除する。**通常session、非該当ID、登録済みBot Taskは削除しない**。作成経路の`generateBotTaskSessionId()`と同じ形式で判定する。`bot_task_sessions` はlist/resume/admission用に存続し、owner判定の正本にはしない。
- ownerにMain/Bot以外の新たな意味を持たせない。`kind` は保持し、group間のsession DBをJOINしない。Memory対象entryの選別、成功条件、snapshotは後続Issue #557。

## ライブラリAPIと一次情報（現行lockfile）

- `better-sqlite3@12.11.1`（`pnpm-lock.yaml`）: `new Database(path, { readonly: true, fileMustExist: true })` でread-only参照、`db.prepare(sql).all(...)` / `.get(...)` / `.run(...)` で束縛値を渡し、`db.transaction(() => { ... }).immediate()` でgroup単位の更新を完結させ、`db.pragma('user_version', { simple: true })` / `db.pragma('user_version = 5')` でschema versionを操作。`db.close()` をfinallyで呼ぶ。API一次情報: https://github.com/WiseLibs/better-sqlite3/blob/v12.11.1/docs/api.md （`new Database`, `prepare`, `transaction`, `pragma`）。このAPIの使用形は既存 `src/agent/session.ts` とも一致する。
- SQLite本体: `ALTER TABLE ... ADD COLUMN ... DEFAULT 'main'` でv4行を初期化してから登録済みBotだけ更新する。既存行の `NOT NULL` 追加には非NULL defaultが必要。新規v5のDDLではdefaultに依存せず新規INSERTでownerを渡すか、Mainの明示defaultを設けてBotの初回INSERTでは必ずBot IDを指定する。transaction・外部キーの仕様を確認する一次情報: https://www.sqlite.org/lang_altertable.html, https://www.sqlite.org/foreignkeys.html, https://www.sqlite.org/pragma.html#pragma_user_version 。SQLのschema version更新は同じgroup DB transaction内で行う。
- テストは既存の `vitest@4.1.5`（lockfile）を使用。`pnpm exec vitest run <対象ファイル>`。API一次情報: https://vitest.dev/guide/cli.html 。新規依存は追加しない。

## 検証

- `src/agent/session.test.ts`: 新規Main owner、既存追記がownerを変えない、rename保持、Bot ownerの独立、group越境なし、read-only owner別trajectoryの順序・payload・存在しないgroupを作らないこと、schema v4をruntimeで暗黙移行しないこと。
- `scripts/convert-issue556-session-owners.test.ts`: tempのv4 group DBとruntime DBを用い、登録済みBot（registry削除済みも同様）、複数Bot/複数group、通常session、未登録の厳密なBot UUIDだけ削除し対応entryも残らないこと、類似prefix通常sessionは保持、entry ID/source保持、再起動後v5として読み出せること、v4以外を変換開始前に検出すること。実データへのテスト書込みをしない。
- `src/agent/bot-task-session.integration.test.ts` / `src/queue/bot-task-sessions.test.ts`: Bot新規作成時の最初のsnapshotからownerがBot ID、resume/追加turn後も不変、Main sessionと混ざらず従来のroleやresumeを維持。
- `src/config/bots.test.ts`: registryに `main` がある時は拒否、他のBotは従来どおり。
- CI相当の品質手順: ルート `CLAUDE.md` に独立した「品質管理の実行手順」節は**存在せず**、同ファイルは `AGENTS.md` へ誘導している。よって変更したBiome対応ファイルは編集直後に `pnpm exec biome check --write <changed-file>`、完了前に `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test` を順に実行・修正する。schema/runnerを変えるため `pnpm build` も実行。事前に新スクリプトの対象テストを実行して失敗→実装→成功を確認する。

## ブラウザでの動作確認（該当範囲と限界）

本IssueにWeb UIはない。ブラウザだけでSQLiteのownerを直接確認することはできないので、ブラウザのDiscord Webは既存Bot動線の回帰確認に使い、永続化はread-only SQLとテストで検証する。実行環境にbot credential・テスト用guildが無い場合は本番で代用せず、手順を未実施として記録する。

1. 対象checkoutで停止・バックアップ・**テスト用の複製DB**の移行を行い、`pnpm build` と必要なrunner image更新を済ませる。テスト用の設定・credential・guildを使い、このcheckoutから通常どおり `pnpm start`（既に管理サービスがある場合はそのサービス）で起動する。並列worktreeで別のサービスが稼働している場合は、`pwd` と `git rev-parse --show-toplevel`、起動プロセス・ログを照合し、テスト用BotとDBが**このcheckout**に結びついていることを確認する。同じBot tokenやDBに複数サービスを同時接続しない。Web配信サーバーや特別なportは不要。
2. ブラウザのDiscord Webでテスト用guildを開き、Mainの通常チャンネルにメッセージを送って応答を確認。別スレッドでも応答を確認する。続いてBot Taskを新規実行してhandleを受け取り、同handleでresume/listを試し、同じBotの文脈が続くことを確認する。実際のslash command名・権限は `docs/guides/discord-bot-setup.md` と設定済みコマンドを確認し、今回コマンド定義・deploymentは変更しない。
3. 起動したサービスが使用した**テスト用の複製DB**をread-onlyで確認: 上記の通常sessionは `agent_id='main'`、Bot Taskは `agent_id=<そのBot ID>`、resume後も同じowner、entryが維持されていること。ブラウザでの応答だけをowner分離の証拠にしない。

## 実装後セルフチェック

新規と記したパス/API/カラム以外の名称は上記の現行コードに存在する。実装者はSQLとcall siteを改めて確認し、進行中の別worktreeの実装に依存しないこと。#556のAcceptance Criteriaが満たされ、#557に属するMemory変更がdiffに含まれないことをチェックする。
