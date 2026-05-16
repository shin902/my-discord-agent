# 技術選定記録

- my-nanoclawのプロジェクトが失敗に終わったので、バイブコーディングの怖さを知った
- どうしてもバイブコーディングはどんどんスケールアップすると厳しい
- "自分もコードを説明できる"を意識した上で、ちゃんとE2Eテストも含めつつ、"確実に動く"を保証した上でどんどん実装していく

## エージェントSDKの選定：pi-agent-core vs droid SDK

### pi-agent-core（採用）
- ミニマル実装でシンプル
- 組み込み型で制御しやすい
- フックが充実 → [pi/core/pi-agent-core-hooks.md](pi/core/pi-agent-core-hooks.md)
- セッション管理は独自実装が必要 → [pi/core/pi-agent-core-session.md](pi/core/pi-agent-core-session.md)
- MCP・スキルは全部自前で実装が必要（許容範囲）

### droid SDK（不採用）
- Opusですら `claude agent sdk` よりベンチマーク性能が良いらしい
- ハーネス最適化が強力（ただDiscordボットとしてはオーバースペック）
- 実行に droid CLI が必須
- フック実装時に不便な点がある
- Specモードなど Discordボットには不要な機能が多い
