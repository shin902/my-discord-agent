- my-nanoclawのプロジェクトが失敗に終わったので、バイブコーディングの怖さを知った
- どうしてもバイブコーディングはどんどんスケールアップすると厳しい
- "自分もコードを説明できる"を意識した上で、ちゃんとE2Eテストも含めつつ、"確実に動く"を保証した上でどんどん実装していく

### 技術スタック：
- `pi coding agent` or `droid agent sdk`
    - `pi coding agent`
        - ミニマル実装ですごくシンプル
        - ただMCP、スキルなどは全部自前で実装しないといけない
    - `droid agent sdk`
        - Opusですら`claude agent sdk`よりベンチマークの性能が良いらしい
        - ハーネス最適化が強い（そんな性能いらないかもだけどね）
        - ハーネスを組む上で、フックとかを実装するときにちょっと不便かも？

- discordのみ実装
    - ただビジネスロジックの分離はめっちゃ意識しとく？一応
    - my-nanoclawで敗北済みだし

- 実装する機能
    - サンドボックス
    - クレデンシャルプロキシ
        - gitのssh鍵とか、tavilyのAPIとかも管理できると嬉しいよな（後回し）
    - discord
        - スレッドごとのチャット、URLとかが送られたらそれにスレッド作成して答える

### それぞれの技術の特徴
- pi agent core
    - [pi/core/pi-agent-core.md](pi/core/pi-agent-core.md)
    - 組み込み型で制御しやすい
    - 割り込みで追加指示が可能（ただDiscord上だとそんないらんよな。やっぱいるかも。待ってられないし）
    - フックが充実 [pi/core/pi-agent-core-hooks.md](pi/core/pi-agent-core-hooks.md)
    - セッション管理は独自実装しないとダメ [pi/core/pi-agent-core-session.md](pi/core/pi-agent-core-session.md)

- pi ai
    - [pi/ai/pi-ai.md](pi/ai/pi-ai.md)
    - 同じセッション内でモデルを自由に切り替えできる処理の大元
    - contextオブジェクトがプロバイダー非依存なんで、それをプロバイダーごとに毎回変換してやる

- droid sdk
    - [droid-sdk.md](droid-sdk.md)
    - 実行にはdroid CLIが必須
    - ハーネス最適化が強力
    - セッション管理が充実（fork、resume、list）
    - Specモード（これもDiscordボットとしてはあんまいらない）
