# Mac画面画像の収集と要約

```text
Mac screencapture → HTTPS / Tailscale Serve → localhost receiver
  → data/screen-captures.sqlite（PNG + 未完了状態）
  → pendingがlimit枚に達したら → 既存queue / pollerでMain Agentが1 batchを確認 → Activity Memoryへ差分統合
```

PNGを収集し、指定AgentGroupの`capturelog`へ画面活動の差分を統合します。Discord配送、検索UI、Project Memoryへの昇格、PII分類は行いません。receiverとsummaryはそれぞれ既定で無効です。実設定やTailscaleの構成は自動変更しません。

## Bot PCの受信設定

`config/config.json`へ追加し、Botを再起動します。

```json
{
  "screenCaptureReceiver": { "enabled": true, "port": 8788 }
}
```

portは1–65535、既定8788です。bindは`127.0.0.1`固定で変更できません。不正な設定やlisten失敗では起動を中止し、shutdown時にはreceiverとDBを閉じます。

[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)でTailnet内にだけ公開します。x-savedが8443を使っている場合も共存できるよう、ここでは8444を使います。

```bash
tailscale serve --bg --https=8444 http://127.0.0.1:8788
tailscale serve status
```

Macを同じTailnetへ接続し、access policyでMacからBot PCの8444へのアクセスだけを許可してください。認証境界はTailnetと信頼済みのBot PCローカルプロセスです。アプリケーションBearer tokenはありません。**Funnel、public reverse proxy、ポート転送、public Internetへの公開は禁止**です。localhost bindだけでは誤設定されたpublic proxyを防げないため、Serve / Funnel状態とTailnet policyを運用者が確認してください。

## Macから送る

リポジトリの`scripts/capture-screen.sh`をMacへコピーし、Serveに表示されたホスト名を指定します。

```bash
bash scripts/capture-screen.sh \
  'https://<host>.<tailnet>.ts.net:8444/v1/screen-captures'
```

macOS標準の`screencapture`、`uuidgen`、`curl`とImageMagickの`magick`を使い、メインディスプレイを1回撮影します。最後にHTTP 200を受けた画像とのSSIMが80%以上なら送信せず、変化があれば縦横比を保って1280x720以内へ縮小して送信します。Terminal等の実行元に「画面収録」の権限が必要です。

継続して収集する場合はLaunchAgentを登録します。間隔は正の秒数で指定でき、既定は60秒です。同じ`on`コマンドを再実行するとURLと間隔を更新できます。

```bash
RECEIVER_URL='https://<host>.<tailnet>.ts.net:8444/v1/screen-captures'
bash scripts/capture-screen.sh on "$RECEIVER_URL"       # 60秒ごと
bash scripts/capture-screen.sh on "$RECEIVER_URL" 300   # 5分ごと（設定変更も同じ）
bash scripts/capture-screen.sh status
bash scripts/capture-screen.sh off
```

`on`は実行時に`magick`の場所を解決してPATHとともに`~/Library/LaunchAgents/com.my-discord-agent.screen-capture.plist`へ保存するため、ログイン後はterminalを閉じても動作し、Mac再起動後も再開します。`status`は登録中ならexit 0、停止中ならexit 1です。`off`は実行中の撮影・送信を含むLaunchAgentを停止してplistを削除し、繰り返し実行しても成功します。logは`~/Library/Logs/my-discord-agent-screen-capture.log`へ追記されます。

送信待ちPNGは`~/Library/Application Support/my-discord-agent/screen-captures/<UUID>.png`、比較基準は同directoryの`.last-acknowledged.png`です。各周期では既存の全PNGを先に再送し、すべてACKされた場合だけ新しく1枚撮影します。1枚でも再送に失敗すると、その周期は新規撮影せず次の周期に再試行するため、receiver停止中にPNGが増え続けません。比較・縮小に失敗した新規captureは未縮小のまま再送待ちへ残しません。失敗の確認には次を使います。

```bash
tail -f "$HOME/Library/Logs/my-discord-agent-screen-capture.log"
```

**curlが正常終了しHTTP 200を受信したら、Bot PCのDB commitが確定しているためMac側PNGを削除します**。送信失敗・ACK不明・非200応答ではPNGを保持します。LaunchAgentは次周期に自動再送し、one-shotでは表示された同じパスを第2引数にして手動再送します。削除に失敗した場合も非zeroで終了し、削除成功とは表示しません。

```bash
bash scripts/capture-screen.sh "$RECEIVER_URL" '/path/to/<UUID>.png'
```

同じUUIDと同じbytesの再送は冪等です。自動captureでは最後にACKされた画像とのSSIMが80%以上なら新しい時点として保存せずskipし、変化がある場合だけ新しいUUIDで送信します。既存PNGを明示的に送る場合は類似度判定を行わず、そのUUIDで送信します。UUIDをbasenameにした`.png`を指定してください。スクリプトはHTTPSの`.ts.net` URLだけを受理し、redirectを追わず、HTTP 200以外をACKとして扱いません。

## pending枚数によるActivity Memory更新

capture保存後、未完了画像が`settings.limit`枚未満なら何もせず、以上なら古いものからちょうど`limit`枚を1 batchとして解析します。`settings.mode`が`summarize`なら、capture側で画像を`settings.visionModel`により個別に並列要約してDBの`summary`へ保存し、全画像の要約が揃ってから通常Agent jobをenqueueします。`direct`ならcapture IDと入力文をenqueueし、各実行・retry時にcapture DBから一時画像をworkspaceへ展開します。実行終了時には画像をcleanupするため、queue待機中にproducerの一時ファイルを保持しません。

Memory更新は既存queue / pollerがMain Agentのper-run sessionで実行します。共通のprovider lock、timeout / abort、retry、lease / fencing、結果commit、session retentionを利用します。同じgroupの未終了capture jobがある間は追加投入せず、Agent成功後のSourceHandlers完了callbackがcapture DBのtransactionで`completed_at`と`accepted = 1`を更新し、次のfull batchを再開します。batchのcapture IDを使ったkeyと既存のactive-only idempotencyで重複投入を抑止します。

capture jobは`discordOutput: "none"`により最終応答・typing・progress・errorの自動Discord出力を抑止します。Discord送信先の設定や`<NO_REPLY>`の応答は不要で、正常終了した空応答も成功です。既存の`<NO_REPLY>`も利用できます。pollerのDiscord接続判定は変わらないため、実行開始には既存どおりDiscord readyが必要です。

起動時にもpendingを確認します。queue内のretryは既存処理に任せ、VLM失敗・Agent終端失敗・完了callback失敗後は次の新規captureまたはHost再起動から再処理します。失敗直後に新jobを作り続けません。成功済みVLM summaryは再利用します。queueとcapture DBを跨ぐatomic commitやexactly-onceは保証しません。Agent成功後にcallbackが失敗した場合もcaptureはpendingのままで、終端jobが残っていても同じbatchを再投入できます。

画像にはpassword、token、個人情報などが含まれ得ます。自動マスキングはありません。`summarize`では画像全体を`settings.visionModel`のproviderへ、`direct`ではMemory更新用の通常modelのproviderへ送信するため、**収集対象と両modeで利用するproviderを確認してから**有効化してください。

`config/config.example.json`のdisabled例を`config/config.json`へ追加し、有効化します。旧`config/cron.json`の`screen-capture-summary` jobは削除してください（有効のままだと起動時にエラーになります）。対象グループには画像を読む`read`とmemory更新用の`write` / `edit`を許可してください。

```json
{
  "screenCaptureSummary": {
    "enabled": true,
    "groupName": "logbook",
    "model": { "provider": "google", "modelId": "gemini-2.5-flash" },
    "settings": {
      "mode": "summarize",
      "visionModel": { "provider": "google", "modelId": "gemini-2.5-flash" },
      "limit": 10,
      "concurrency": 4
    }
  }
}
```

- `model`はMemory更新用の通常LLMです。この設定を優先し、省略時はグループ設定へfallbackします。
- `settings.mode`は`summarize`（既定）または`direct`です。
- `settings.visionModel`は`summarize`で必須です。Credential Proxyに定義した画像入力対応モデルを指定します。`direct`では指定しません。
- `settings.concurrency`はVLM worker数（1–16、既定4）です。実際の要約実行は [providerの同時実行上限とresourceの排他制御](config.md#configprovidersjson) にも従います。例えばworker数4・provider上限2なら、同じproviderの通常AgentやBotを含め合計2枠までです。同じresourceを使う別providerとは交代で実行します。`serial`なら直列になります。
- `settings.limit`はfull batchを開始する未完了画像数、1回の解析枚数、1 batchの最大処理枚数を兼ねます（1以上、既定10）。上限はありませんが、Agent Runnerの実行時間と512 MiB sandboxに収まる有限のwork budgetとして設定してください。
- screen-capture固有のtimeoutはありません。Agent実行には共通のAgent Runner timeoutが適用されます。実用上はresize済み画像を20〜数十枚程度扱うbest-effort運用を想定し、任意枚数の処理完了は保証しません。
- VLMが1枚でも失敗したbatchは全画像が未完了で残り、成功済みsummaryは次回に再利用されます。通常LLM成功後・DB更新前に停止した場合も再実行されるため、既存`capturelog`との差分だけを反映するよう指示します。
- ImageMagickがdecode不能と判定した画像は`accepted = 0`で完了します。そのbatchでは不足分を追加取得せず解析を行わず、残るpendingが`limit`枚に達したら改めてfull batchを形成します。`magick` executable不在などの実行環境エラーは画像不正として完了させません。
- 同一Host内のsummary consumerは一つだけです。別processを含む複数consumerはサポートしません。変更反映にはBot再起動が必要です。

完了済み画像は専用の`screen-capture-gc` cronで`completed_at`から24時間後に削除します。`accepted`の値は問わず、未完了画像は削除しません。設定例は`config/cron.example.json`にあります。

## 日付境界による日次レポート

`config/config.json` の `screenCaptureDailySummary` を有効にすると、翌日以降のcapture受信を契機に、対象日の画面処理がすべて完了した後で別のAgent jobをenqueueします。日付は撮影時刻のJST（`Asia/Tokyo`）です。現在時刻や受信時刻では判定しません。

```json
{
  "screenCaptureDailySummary": {
    "enabled": true,
    "groupName": "logbook",
    "startDate": "2026-10-03",
    "prompt": "capturelog内の対象日 {{date}} の活動ログを分析して日次レポートを作成してください。",
    "channelId": "YOUR_CHANNEL_ID",
    "deliveryMode": "new-thread",
    "sessionMode": "per-run",
    "model": { "provider": "google", "modelId": "gemini-2.5-flash" },
    "tools": ["read"]
  }
}
```

- `groupName` は有効な `screenCaptureSummary` と同じgroupを指定します。
- `startDate` はこの方式で最初にレポートを生成する日（JST、`YYYY-MM-DD`、その日を含む）です。既存cronから移行する場合、最後にレポート済みの日の翌日を指定します。既存cronの成功履歴は自動移行しません。
- `prompt` は必須です。`{{date}}` は対象日に置換され、対象日を明示した指示も付加されます。既存promptの「昨日」は対象日に読み替えてください。
- `channelId` は必須のDiscord出力先です。`deliveryMode` は `direct`（既定）/ `new-thread` / `item-thread`、`sessionMode` は `per-run`（既定）または `destination` で、通常cronと同じ意味です。`item-thread` は `sessionMode: "destination"` と組み合わせてください。`sessionMode` を省略すると既定値の `per-run` と衝突するため、この組み合わせは起動時の設定検証で拒否されます。
- `botId` は省略可能です。指定すると通常cronと同じくBot profileを適用し、`groupName` から利用できるBotに限られます。
- `model` / `tools` / `skills` / `contextFiles` / `mounts` などのAgent設定は日次job専用です。省略時はgroup設定を継承します。画像batchのAgent設定は継承しません。

通常batchの `limit` 条件は変更しません。前日分に端数が残る場合は、後日のcaptureでfull batchが成立し、前日分まで完了するのを待ちます。翌日の画像処理が未完了でも、対象日以前のpendingがなければ日次レポートを生成できます。

captureのある日だけを、`startDate`以降かつ最新受信撮影日より前の範囲で古い順に処理します。captureがない日はレポートを作りません。日次jobは一度に1日だけ投入し、Agent成功時に最後の成功日をwatermarkへ保存して、次の日を確認します。成功はAgent結果のqueue commitを意味し、Discord配送完了とは別です。失敗時はwatermarkを進めず、既存queueのretryに任せます。終端失敗後の再投入は次の新規capture、別batchの成功、またはHost再起動で行います。

受信した撮影日とgroupごとのwatermarkはhost専用capture DBに保存し、画像GCでは削除しません。レポート済み日付の履歴一覧は保持しません。成功commit後に完了callbackが中断された場合は、残っているqueueの成功jobからwatermarkを復旧します。両DBを跨ぐatomic commitやexactly-onceは保証しません。既存画像は導入時に撮影日を登録しますが、導入前にGC済みの画像の日付は復元できません。watermark以前の日付のcaptureが後から届いても、レポートは再生成しません。

移行時は旧 `screen-capture-daily-summary` cronを停止・削除し、旧jobの処理を終えてからこの設定を追加してHostを再起動してください。画像GCのcronは維持します。実設定は自動変更しません。

### 参考Memoryテンプレート

[`templates/capturelog/`](../templates/capturelog/)に、画面活動を`capturelog/YYYY-MM/YYYY-MM-DD.md`へ統合するための参考テンプレートがあります。配下の`memory/`と`capturelog/`はAgentGroup workspaceへの配置構造をそのまま表します。まだ実運用で十分に検証された推奨設定ではないため、既存ファイルへ一括上書きせず、必要な内容を確認して取り込んでください。

このテンプレートは画面Activity Memoryへ特化しています。通常の汎用memoryとして使う場合は、日次ログをそのまま常時contextへ入れるのではなく、別途コンパクトなsummary/indexへ統合する運用が必要です。

## 受信プロトコル

`POST /v1/screen-captures`へraw PNG bytesを送ります。

| 入力 | 契約 |
|---|---|
| `Content-Type` | `image/png` |
| `X-Capture-Id` | 撮影ごとのUUID（受信側で小文字へ正規化） |
| `X-Captured-At` | 必須。撮影時刻のUTC ISO 8601（秒精度、例: `2025-01-02T03:04:05Z`） |
| body | 20 MiB以下のPNG。圧縮HTTP bodyやmultipart / JSONは非対応 |

PNG signatureを検証しますが、receiver内では画像をdecodeしません。後段でdecode不能と判定された画像は`accepted = 0`で完了し、後続画像の処理を継続します。bodyサイズはストリームを数えて制限します。web-pageからの書込みを防ぐため、`Origin`付きrequestは拒否し、CORSは有効化しません。

SQLite commit後だけ`200 {"accepted":"<uuid>"}`を返します。同じID・同じPNGの再送は撮影時刻が異なっても初回保存値を維持します。同じIDで異なる画像は409、ID・撮影時刻・PNG不正は400、サイズ超過は413、形式・encoding不正は415、Originは403、保存失敗は500です。エラー応答に`accepted`は含みません。別pathは404、POST以外は405です。

## 永続化・確認・backup

`data/screen-captures.sqlite`はhost専用でsandboxへmountしません。`SCREEN_CAPTURE_DB_PATH`で変更でき、相対パスはrepository root基準です。テーブル`screen_captures`は`id`、PNG BLOBの`image`、UTC撮影時刻`received_at`（既存列名を維持）、nullableなVLM要約`summary`、`completed_at`、採否を表す`accepted`を持ちます。**`completed_at IS NULL`が未完了、非NULLが完了**の正本です。

ローカルでのread-only確認例（画像や要約本文を端末ログへ出さない）:

```bash
sqlite3 -readonly data/screen-captures.sqlite \
  'SELECT id, received_at, length(image) AS bytes, completed_at IS NOT NULL AS is_completed FROM screen_captures ORDER BY received_at;'
```

DB本体は0600、WAL運用です。稼働中にmain fileだけをcopyせず、SQLite backup API / CLIの`.backup`を使うかBot停止後にbackupしてください。**このDBのbackupは画像本体も含みます**。runtime DBのbackupとは別です。完了済みの画像・要約は24時間保持し、`screen-capture-gc`実行時に削除します。SQLiteファイル自体の即時縮小は保証せず、空きpageの再利用で将来の増加を抑えます。既存DBを縮小する必要がある場合だけ、Bot停止中に手動で`VACUUM`してください。未完了画像には自動削除期限がありません。Mac側は撮影時刻をPNGの更新時刻に保持し、再送時も同じ値を送ります（既存PNGの手動再送ではそのファイルの更新時刻を使用）。Mac側はACK後に削除しますが、未ACK・削除失敗のPNGは再送または明示削除が必要です。旧版で成功後も残ったPNGは自動走査しないため、同じパスで再送してACK後に削除するか、不要と確認して明示的に削除してください。

導入時はMacから1枚撮影し、DBで未完了を確認→limit枚到達後の完了とActivity Memory更新を確認してください。receiverを止めた送信失敗→同じUUIDで再送し1行だけになること、Agent失敗中は未完了が残り復旧後に完了することも確認します。自動テストはHTTP / SQLite、全画像のworkspace配置、Agent成功・失敗時の完了状態、senderのMacコマンド模擬までを検証します。実Macの画面収録権限、Tailnet到達性、実providerの画面理解は別途実機確認が必要です。
