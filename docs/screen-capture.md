# Mac画面画像の収集と要約

```text
Mac screencapture → HTTPS / Tailscale Serve → localhost receiver
  → data/screen-captures.sqlite（PNG + 未読）
  → cron → 並列のツールなし画像要約 → 同じDBへ要約を保存（既読）
```

初版はPNGの収集・画像ごとの要約だけです。専用AgentGroup、Discord配送、検索UI、Project Memory / Activityへの昇格、PII分類は行いません。receiverとcronはそれぞれ既定で無効です。実設定やTailscaleの構成は自動変更しません。

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

## Macメニューバー collector

常駐収集には、macOS標準APIを使うSwiftUIのMenuBarExtraアプリを使います。XcodeまたはSwift toolchainが入ったMacで、リポジトリのルートからbuildして起動します。

```bash
./macos/build-screen-capture-collector.sh
open macos/build/ScreenCaptureCollector.app
```

初回起動後にメニューバーのアイコンからSettingsを開き、Tailscale ServeのURLを保存します。受理される形式は次だけです（portは省略可）。

```text
https://<host>.<tailnet>.ts.net[:<port>]/v1/screen-captures
```

HTTP、`.ts.net`以外のhost、query / fragment、認証情報付きURL、範囲外のportは保存できません。URLはUserDefaultsへ保存され、外部の設定ファイルやcredentialは使いません。

初回の`Capture Now`でmacOSの「画面収録」権限を求めます。System Settings → Privacy & Security → Screen Recordingでこのアプリを許可してください。権限の許可済み / 要求状態と、権限不足やメインディスプレイの取得・PNG化の失敗はメニューバーに表示されます。アプリはメインディスプレイだけを撮影し、複数ディスプレイの合成や自動マスキングは行いません。

自動撮影の間隔は30秒 / 1分 / 5分から選べ、既定は1分です。Pauseは自動撮影と自動pending retryを停止し、状態をUserDefaultsへ保存します。Pause中も明示的な`Capture Now`と`Retry Pending`は実行できます。再開するとタイマーが動き、保存済みpending PNGも再送します。

撮影直後のPNGは`~/Library/Application Support/my-discord-agent/screen-captures/<UUID>.png`へprivateな権限で保存されます。これは再起動後も残るdurable queueです。送信中は同じUUIDのファイルを使い、通信失敗・redirect・HTTP 200以外・ACK不明では削除しません。**HTTP statusが正確に200のときだけDB commit済みACKとみなし、その後にPNGを削除します**。削除自体に失敗した場合はファイルをpendingとして残し、同じUUIDで再試行できます。メニューバーにはRecording / Paused、Screen Recording権限、Last upload、Pending件数を表示し、直近の失敗時はFailureを表示します。

画像全体を選択したreceiver / cron providerへ送信します。MenuBarExtraは認証情報を追加せず、redirectも追いません。Mac側にSQLiteや別の履歴DBは作らず、設定はUserDefaults、未ACKの画像はpendingディレクトリだけに保持します。画像に秘密情報や個人情報が含まれる可能性があるため、収集対象・Tailnet policy・providerを確認してから使ってください。自動マスキング、個別retention、Memory / Activityへの自動昇格はありません。

### Shell fallback

アプリを使わない場合は、リポジトリの`scripts/capture-screen.sh`をMacへコピーし、Serveに表示されたホスト名を指定します。アプリと同じURL検証・送信・ACK・pending PNG削除の契約です。

```bash
bash scripts/capture-screen.sh \
  'https://<host>.<tailnet>.ts.net:8444/v1/screen-captures'
```

既存PNGの再送:

```bash
bash scripts/capture-screen.sh "$RECEIVER_URL" '/path/to/<UUID>.png'
```

新しい撮影には新しいUUIDを使います。同じUUIDと同じbytesの再送はreceiver側で冪等です。スクリプトもredirectを追わず、HTTP 200以外をACKとして扱いません。常駐タイマーはないため、単発撮影やアプリが使えない場合のfallbackとして使用してください。

## cron要約

画像全体が選択したLLM providerへ送られます。画面や生成要約に秘密情報・個人情報が含まれ得るため、**収集対象とproviderを確認してから**明示的に有効化してください。自動マスキングはありません。

`config/cron.example.json`のdisabled例を`config/cron.json`へ追加し、有効化します。**同じDBに対するjobは1つ、Botプロセスも1つ**にしてください。

```json
{
  "id": "screen-capture-summary",
  "schedule": "5m",
  "enabled": true,
  "handler": "jobs/screen-capture-summary.ts",
  "model": { "provider": "google", "modelId": "gemini-2.5-flash" },
  "settings": { "concurrency": 4, "timeoutMs": 120000 }
}
```

- `model`はこのjobの指定を使い、省略時は`config.json`の`defaultModel`へfallbackします。group / channel / tools / skills / mountsは使いません。
- [Credential設定](config/credential-proxy.md)にLLM接続を定義します。上の例は`credentials.example.json`の`google` entryとhostの`GEMINI_API_KEY`を使用します。画像入力可能なモデルが必須です。カスタムモデルは`models[modelId].input: ["text", "image"]`も指定してください。
- 対応wire APIは`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`です。SDKへ渡すのはlocalhostのCredential Proxy URLと非secret placeholderだけです。実キーはProxyで注入します。Codexを使う場合は[CLIProxyAPI](guides/codex-oauth-cliproxyapi.md)経由の`openai-responses`にします。
- `settings.concurrency`は1–16、既定4。全未読IDを対象にしつつ画像本体はworker単位で読みます。これはbatch件数制限ではありません。[providers.json](config.md#configprovidersjson)の既存の共通provider lockも守るため、`serial`または未設定providerは直列になります。並列化するproviderには例として`{ "provider": "google", "concurrency": "parallel" }`を設定してください。
- `settings.timeoutMs`は1–600000、既定120000。1画像のprovider lock待ち＋LLM処理の上限です。要約の出力上限は2048 tokens（モデル上限が小さければそちら）です。
- 一度だけ未読IDをsnapshotし、その全件を処理します。処理中に到着した画像は次回対象です。同一jobのtick重複は[cron runner](spec/cron.md#実行タイミングと長時間実行)が抑止します。cron設定変更後はBotの再起動が必要で、既存cronと同じくDiscord ready後に動作します。
- 正常終了した空でない要約だけを保存します。通信エラー、timeout、空応答、途中終了は未読のまま次の実行で再試行します。画像ごとの失敗は他の画像を止めません。ログにはIDと件数だけを出し、画像・要約・providerの生エラーは出しません。
- 要約保存と既読化は同じSQL更新です。DBエラーではjobを失敗させ、開始済みworkerの完了を待ってDBを閉じます。再起動時も既読画像はスキップします。LLM成功後・DB保存前に停止した場合、その画像は再要約され得ます。別のqueueやleaseは追加しません。

## 受信プロトコル

`POST /v1/screen-captures`へraw PNG bytesを送ります。

| 入力 | 契約 |
|---|---|
| `Content-Type` | `image/png` |
| `X-Capture-Id` | 撮影ごとのUUID（受信側で小文字へ正規化） |
| body | 20 MiB以下のPNG。圧縮HTTP bodyやmultipart / JSONは非対応 |

PNG signatureを検証しますが、receiver内では画像をdecodeしません。破損したPNGの要約が失敗した場合は未読として残ります。bodyサイズはストリームを数えて制限します。web-pageからの書込みを防ぐため、`Origin`付きrequestは拒否し、CORSは有効化しません。

SQLite commit後だけ`200 {"accepted":"<uuid>"}`を返します。同じIDで異なる画像は409、ID・PNG不正は400、サイズ超過は413、形式・encoding不正は415、Originは403、保存失敗は500です。エラー応答に`accepted`は含みません。別pathは404、POST以外は405です。

## 永続化・確認・backup

`data/screen-captures.sqlite`はhost専用でsandboxへmountしません。`SCREEN_CAPTURE_DB_PATH`で変更でき、相対パスはrepository root基準です。テーブル`screen_captures`は`id`、PNG BLOBの`image`、UTC受信時刻`received_at`、nullableな`summary`を持ちます。**`summary IS NULL`が未読、非NULLが既読**の正本で、重複するstatus列は持ちません。

ローカルでのread-only確認例（画像や要約本文を端末ログへ出さない）:

```bash
sqlite3 -readonly data/screen-captures.sqlite \
  'SELECT id, received_at, length(image) AS bytes, summary IS NOT NULL AS is_read FROM screen_captures ORDER BY received_at;'
```

DB本体は0600、WAL運用です。稼働中にmain fileだけをcopyせず、SQLite backup API / CLIの`.backup`を使うかBot停止後にbackupしてください。**このDBのbackupは画像本体も含みます**。runtime DBのbackupとは別です。Bot PC側の画像・要約には自動削除期限を設けず、容量・retention・backupのアクセス権を運用者が管理します。Mac側はACK後に削除しますが、未ACK・削除失敗のPNGは再送または明示削除が必要です。旧版で成功後も残ったPNGは自動走査しないため、同じパスで再送してACK後に削除するか、不要と確認して明示的に削除してください。

導入時はMacから1枚撮影し、DBで未読を確認→cron後の既読を確認してください。receiverを止めた送信失敗→同じUUIDで再送し1行だけになること、要約provider停止中は未読が残り復旧後に既読になることも確認します。自動テストはHTTP / SQLite、実SDK＋ローカル模擬provider、失敗再試行、並列数、senderのMacコマンド模擬までを検証します。実Macの画面収録権限、Tailnet到達性、実providerの画面理解は別途実機確認が必要です。
