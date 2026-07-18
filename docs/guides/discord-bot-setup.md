# Discord Bot セットアップガイド

xangi を Discord で使用するための Bot 作成手順。

## 1. Discord Developer Portal にアクセス

https://discord.com/developers/applications

Discord アカウントでログイン。

## 2. 新しいアプリケーション作成

1. 右上の **「新しいアプリケーション」** をクリック
2. 名前を入力:（任意の名前）
3. **「作成」** をクリック

## 3. Bot 作成とトークン取得

1. 左メニューの **「Bot」** をクリック
2. **「トークンをリセット」** → **「実行します！」**
3. 表示された トークンを「**コピー**」（後で使用）

⚠️ **注意**: トークンは一度しか表示されない。紛失した場合は再生成が必要。

## 4. Bot 権限設定（重要）

同じ Bot ページで **Privileged Gateway Intents** を設定：

| Intent | 必須 | 説明 |
|--------|------|------|
| Presence Intent | 任意 | ユーザーのオンライン状態取得 |
| Server Members Intent | 任意 | サーバーメンバー情報取得 |
| **Message Content Intent** | **必須** | メッセージ内容の読み取り |

**⚠️ Message Content Intent を ON にしないとメッセージが読めない！**

## 5. Bot をサーバーに招待

1. 左メニュー **「OAuth2」** → **「OAuth2 URLジェネレーター」**
2. **スコープ** で選択：
   - ✅ `bot`
   - ✅ `applications.commands`（スラッシュコマンド用）
3. **BOTの権限** で選択：
   - ✅ メッセージを送る
   - ✅ Threadsでメッセージを送る
   - ✅ 公開スレッドの作成（一応チェックをつけたほうがいいかも？）
   - ✅ メッセージ履歴を読む
   - ✅ リアクションを付ける
   - ✅ スラッシュコマンドを使用
4. 生成された URL をコピー
5. ブラウザで URL を開き、Bot を招待するサーバーを選択




このドキュメントは https://github.com/karaage0703/xangi/blob/main/docs/discord-setup.md このドキュメントを元に最新の情報に変更した上でこのリポジトリ用に最適化したものです。