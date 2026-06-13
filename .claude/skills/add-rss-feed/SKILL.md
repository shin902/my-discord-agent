---
name: add-rss-feed
description: "FeedCordでRSS/YouTubeフィードの更新をDiscordチャンネルにWebhook投稿させ、auto-threadモードでエージェントが自動でスレッドを立てて反応するように設定する。「RSSフィードを監視したい」「feedcordを設定したい」「ニュースを自動でまとめてほしい」と言われたら使う。"
---

# add-rss-feed

[FeedCord](https://github.com/Qolors/FeedCord)(RSS/YouTube → Discord Webhook 投稿ツール)とこのリポジトリの `auto-thread` モードを組み合わせ、フィード更新が来たら自動でスレッドが作られ、エージェントが反応する状態を作る。

## 全体の流れ

```
FeedCord (別プロセス/コンテナ)
  └─ RSS/YouTubeフィードをポーリング
       └─ 更新があれば Discord Webhook で対象チャンネルに投稿
            └─ src/discord/handler.ts が受信
                 ├─ allowedWebhookIds に webhook ID が登録済み → 処理続行
                 ├─ sessionMode: "auto-thread" → 投稿からスレッドを自動作成
                 └─ エージェントがスレッド内で反応(要約・コメントなど)
```

`message.author.bot` は Webhook 投稿でも `true` になるため、何も設定しなければ無視される。
このリポジトリでは `config/config.json` の `channels[].allowedWebhookIds` にこの Webhook の ID を登録することで、その Webhook からの投稿だけを例外的に処理対象にできる(`src/discord/handler.ts` 参照)。

## 手順

### 1. Discordチャンネルと Webhook を準備

1. RSS更新の投稿先にしたいチャンネルを決める(または新規作成)。専用チャンネル推奨(`auto-thread` は親チャンネルの全メッセージにスレッドを作るため)。
2. そのチャンネルの「チャンネルを編集」→「連携サービス」→「ウェブフック」→「新しいウェブフック」で Webhook を作成。
3. 「ウェブフックURLをコピー」で取得できるURLは次の形式:

   ```
   https://discord.com/api/webhooks/<WEBHOOK_ID>/<WEBHOOK_TOKEN>
   ```

   `<WEBHOOK_ID>` と URL全体の両方を控えておく。

### 2. FeedCord をセットアップ

FeedCordは本リポジトリとは別プロセス(別ホスト/別コンテナでも可)として動かす。

`appsettings.json` を用意する:

```json
{
  "Instances": [
    {
      "Id": "My RSS Feed",
      "RssUrls": [
        "https://example.com/feed.xml"
      ],
      "YoutubeUrls": [],
      "Forum": false,
      "DiscordWebhookUrl": "https://discord.com/api/webhooks/<WEBHOOK_ID>/<WEBHOOK_TOKEN>",
      "RssCheckIntervalMinutes": 25,
      "EnableAutoRemove": false,
      "Color": 8411391,
      "DescriptionLimit": 250,
      "MarkdownFormat": false,
      "PersistenceOnShutdown": true
    }
  ],
  "ConcurrentRequests": 40
}
```

Dockerで起動:

```bash
docker pull qolors/feedcord:latest
docker run -d --name feedcord-<用途> \
  -v "/path/to/your/appsettings.json:/app/config/appsettings.json" \
  --restart unless-stopped \
  qolors/feedcord:latest
```

複数フィード(用途別)を分けたい場合は `Instances` 配列に追加するか、`appsettings.json`/コンテナをフィード単位で分ける。

### 3. config/config.json にチャンネルを追加

`groups[].channels[]` に `sessionMode: "auto-thread"` と `allowedWebhookIds` を設定する。

```json
{
  "name": "rss",
  "channels": [
    {
      "channelId": "<対象チャンネルのID>",
      "sessionMode": "auto-thread",
      "allowedWebhookIds": ["<WEBHOOK_ID>"]
    }
  ]
}
```

- 既存グループの1チャンネルとして追加してもよいし、専用グループ(`rss`など)を新設してもよい。ユーザーに確認する。
- `allowedWebhookIds` は配列なので、同じチャンネルに複数のFeedCord Webhookを使う場合はすべて列挙する。

### 4. (任意) グループの応答方針を設定

`groups/{name}/AGENTS.md` に、RSS投稿への反応方法を書いておくとよい(例: 「フィード投稿が来たら内容を日本語で3行要約し、関連しそうな話題があればコメントする」など)。`groups/{name}/AGENTS.md` が存在しない場合は新規作成する。

### 5. ビルド・再起動して確認

`group-config.ts` は起動時にキャッシュされるため、`config/config.json` 変更後はプロセスの再起動が必要。

```bash
pnpm build
# 既存のサービス再起動方法に従う(例: ./service.sh restart 等、リポジトリの運用方法を確認)
```

再起動後、FeedCordがフィード更新を検知してWebhook投稿 → 対象チャンネルにスレッドが自動作成 → エージェントが応答することを確認する。

## トラブルシューティング

- **スレッドが作られない / 反応が無い**
  - `allowedWebhookIds` の値が、Webhook URLの `<WEBHOOK_ID>` 部分(数字)と一致しているか確認
  - `config/config.json` 変更後にプロセスを再起動したか確認(キャッシュは再起動まで更新されない)
  - `sessionMode` が `"auto-thread"` になっているか確認
  - FeedCord側のログでWebhook投稿自体が成功しているか確認
- **Webhook IDが分からなくなった**
  - Discordのチャンネル設定 → 連携サービス → 該当Webhookを開くと、URL内に同じIDが表示される
