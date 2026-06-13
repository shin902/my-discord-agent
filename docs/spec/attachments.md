# 添付ファイル対応

Discordメッセージの添付ファイル（画像）をエージェントに渡す仕組み。issue #94。

## フロー

```
1. discord/handler.ts
     message.attachments を AttachmentRef[] として InboxMessage に積む

2. agent/manager.ts (sendMessage)
     - data/attachments/{group}/{sessionId}/ にダウンロード
     - コンテナの /workspace/attachments に読み取り専用マウント
     - プロンプトに [添付ファイル] セクションでパス一覧を追記

3. tools/fs.ts (read ツール)
     画像拡張子(png/jpg/jpeg/gif/webp)を base64 の image content として返す
```

## 制限

- 添付ファイル数: 最大5件（`MAX_ATTACHMENTS`）
- ダウンロード時のサイズ上限: 10MB/件（`MAX_ATTACHMENT_BYTES`）
- read ツールでの画像読み込み上限: 10MB（`READ_IMAGE_BYTE_LIMIT`）

上限を超えるファイルはダウンロード/読み込みをスキップし、処理自体は継続する。

## `data/attachments/` の保持方針

**ダウンロードしたファイルは自動削除しない。**

- 添付ファイルはDiscord側にも残っているため、`data/attachments/` は処理用キャッシュという位置づけ
- ディスク容量が問題になった場合は、保持期間ベースで削除する汎用cronを別途追加する想定
- このPR(#100)では削除ロジックは意図的に組み込んでいない

## スコープ外（別issue予定）

- GLM-OCR / Gemini動画理解 / Whisper / Embedding 等のマルチモーダルツール対応
- PDFのページ画像変換対応（poppler-utils等のコンテナ依存追加が必要）
