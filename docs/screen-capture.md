# Mac画面画像の収集と要約

```text
Mac screencapture → HTTPS / Tailscale Serve → localhost receiver
  → data/screen-captures.sqlite（PNG + 未完了状態）
  → cron → logbook Agentが全画像を一括確認 → Activity Memoryへ差分統合
```

PNGを収集し、指定AgentGroupのfile memoryへ画面活動の差分を統合します。Discord配送、検索UI、Project Memoryへの昇格、PII分類は行いません。receiverとcronはそれぞれ既定で無効です。実設定やTailscaleの構成は自動変更しません。

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

macOS標準の`screencapture`、`uuidgen`、`curl`を使い、メインディスプレイを1回撮影します。Terminal等の実行元に「画面収録」の権限が必要です。

継続して収集する場合はLaunchAgentを登録します。間隔は正の秒数で指定でき、既定は60秒です。同じ`on`コマンドを再実行するとURLと間隔を更新できます。

```bash
RECEIVER_URL='https://<host>.<tailnet>.ts.net:8444/v1/screen-captures'
bash scripts/capture-screen.sh on "$RECEIVER_URL"       # 60秒ごと
bash scripts/capture-screen.sh on "$RECEIVER_URL" 300   # 5分ごと（設定変更も同じ）
bash scripts/capture-screen.sh status
bash scripts/capture-screen.sh off
```

`on`は`~/Library/LaunchAgents/com.my-discord-agent.screen-capture.plist`を作成して登録するため、ログイン後はterminalを閉じても動作し、Mac再起動後も再開します。`status`は登録中ならexit 0、停止中ならexit 1です。`off`は実行中の撮影・送信を含むLaunchAgentを停止してplistを削除し、繰り返し実行しても成功します。logは`~/Library/Logs/my-discord-agent-screen-capture.log`へ追記されます。

送信待ちPNGは`~/Library/Application Support/my-discord-agent/screen-captures/<UUID>.png`です。各周期では既存の全PNGを先に再送し、すべてACKされた場合だけ新しく1枚撮影します。1枚でも再送に失敗すると、その周期は新規撮影せず次の周期に再試行するため、receiver停止中にPNGが増え続けません。失敗の確認には次を使います。

```bash
tail -f "$HOME/Library/Logs/my-discord-agent-screen-capture.log"
```

**curlが正常終了しHTTP 200を受信したら、Bot PCのDB commitが確定しているためMac側PNGを削除します**。送信失敗・ACK不明・非200応答ではPNGを保持します。LaunchAgentは次周期に自動再送し、one-shotでは表示された同じパスを第2引数にして手動再送します。削除に失敗した場合も非zeroで終了し、削除成功とは表示しません。

```bash
bash scripts/capture-screen.sh "$RECEIVER_URL" '/path/to/<UUID>.png'
```

同じUUIDと同じbytesの再送は冪等です。新しい撮影には新しいUUIDを使うので、画面が同じでも別の時点の記録として保存できます。既存PNGを送る場合もUUIDをbasenameにした`.png`へコピーしてください。スクリプトはHTTPSの`.ts.net` URLだけを受理し、redirectを追わず、HTTP 200以外をACKとして扱いません。

## cronによるActivity Memory更新

未完了画像を5分ごとに全件snapshotし、指定したAgentGroupのworkspaceへ一時PNGとして配置します。Agentはグループの`contextFiles`とtoolsを使い、全画像を1回のrunで確認して既存memoryとの差分だけを反映します。成功後にだけDBの`completed_at`を更新し、一時PNGを削除します。Agent失敗・timeout・プロセス停止では未完了のまま次回再試行します。

`config/cron.example.json`のdisabled例を`config/cron.json`へ追加し、有効化します。対象グループには画像を読む`read`とmemory更新用の`write` / `edit`を許可してください。

```json
{
  "id": "screen-capture-summary",
  "schedule": "5m",
  "enabled": true,
  "groupName": "logbook",
  "handler": "jobs/screen-capture-summary.ts",
  "model": { "provider": "google", "modelId": "gemini-2.5-flash" },
  "settings": { "timeoutMs": 120000 }
}
```

- `model`はcron指定を優先し、省略時はグループ設定へfallbackします。tools・skills・mounts・contextFilesはグループ設定を使います。
- `settings.timeoutMs`は1–600000、既定120000で、Agent run全体の上限です。
- DBのPNG BLOBは`groups/<group>/.screen-captures/`へ一時配置され、Agentから`/workspace/.screen-captures/<id>.png`として読めます。
- 同一jobのtick重複はcron runnerが抑止します。変更反映にはBot再起動が必要です。
- Agent成功後・DB更新前に停止した場合は再実行されますが、Agentには既存memoryとの差分だけを反映するよう指示します。

## 受信プロトコル

`POST /v1/screen-captures`へraw PNG bytesを送ります。

| 入力 | 契約 |
|---|---|
| `Content-Type` | `image/png` |
| `X-Capture-Id` | 撮影ごとのUUID（受信側で小文字へ正規化） |
| body | 20 MiB以下のPNG。圧縮HTTP bodyやmultipart / JSONは非対応 |

PNG signatureを検証しますが、receiver内では画像をdecodeしません。破損したPNGでAgent処理が失敗した場合は未完了として残ります。bodyサイズはストリームを数えて制限します。web-pageからの書込みを防ぐため、`Origin`付きrequestは拒否し、CORSは有効化しません。

SQLite commit後だけ`200 {"accepted":"<uuid>"}`を返します。同じIDで異なる画像は409、ID・PNG不正は400、サイズ超過は413、形式・encoding不正は415、Originは403、保存失敗は500です。エラー応答に`accepted`は含みません。別pathは404、POST以外は405です。

## 永続化・確認・backup

`data/screen-captures.sqlite`はhost専用でsandboxへmountしません。`SCREEN_CAPTURE_DB_PATH`で変更でき、相対パスはrepository root基準です。テーブル`screen_captures`は`id`、PNG BLOBの`image`、UTC受信時刻`received_at`、nullableな`summary`（旧個別要約）と`completed_at`を持ちます。**`completed_at IS NULL`が未完了、非NULLが完了**の正本です。

ローカルでのread-only確認例（画像や要約本文を端末ログへ出さない）:

```bash
sqlite3 -readonly data/screen-captures.sqlite \
  'SELECT id, received_at, length(image) AS bytes, completed_at IS NOT NULL AS is_completed FROM screen_captures ORDER BY received_at;'
```

DB本体は0600、WAL運用です。稼働中にmain fileだけをcopyせず、SQLite backup API / CLIの`.backup`を使うかBot停止後にbackupしてください。**このDBのbackupは画像本体も含みます**。runtime DBのbackupとは別です。Bot PC側の画像・要約には自動削除期限を設けず、容量・retention・backupのアクセス権を運用者が管理します。Mac側はACK後に削除しますが、未ACK・削除失敗のPNGは再送または明示削除が必要です。旧版で成功後も残ったPNGは自動走査しないため、同じパスで再送してACK後に削除するか、不要と確認して明示的に削除してください。

導入時はMacから1枚撮影し、DBで未完了を確認→cron後の完了とActivity Memory更新を確認してください。receiverを止めた送信失敗→同じUUIDで再送し1行だけになること、Agent失敗中は未完了が残り復旧後に完了することも確認します。自動テストはHTTP / SQLite、全画像のworkspace配置、Agent成功・失敗時の完了状態、senderのMacコマンド模擬までを検証します。実Macの画面収録権限、Tailnet到達性、実providerの画面理解は別途実機確認が必要です。
