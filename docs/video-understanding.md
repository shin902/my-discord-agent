# Gemini動画理解

`video-understand` は、会話モデルとは独立してGeminiへ動画の映像・音声の解析を依頼するsandbox tool。`agent-reach` のYouTube字幕・メタデータ取得は引き続き利用できる。

## 設定

1. ホストの環境変数に `GEMINI_API_KEY` を設定する。
2. `config/credentials.json` に `google` の接続定義がなければ、既存の設定形式で追加する。

   ```json
   {
     "provider": "google",
     "envVars": ["GEMINI_API_KEY"],
     "baseUrl": "https://generativelanguage.googleapis.com/v1beta"
   }
   ```

3. 利用するgroup/channel、Bot profile、またはcron jobの `tools` に `video-understand` を追加する。tools配列は継承元を完全置換するため、他に必要なtoolも含める。
4. 配布runner imageを `pnpm runner:image:build` で更新し、設定変更後にホストを再起動する。

専用の設定項目は不要。tool内で `google` の接続先、`gemini-2.5-flash`、120000msのタイムアウトを使用する。会話モデルの設定は変更しない。

実APIキーはホストだけに保持し、sandboxからのリクエストには既存のCredential Proxyが認証を付与する。sandboxの環境変数から実APIキーを読み取らず、既存の `CREDENTIAL_PROXY_JSON` で渡された接続先を使う。host executorやFiles APIは使わない。

## 入力と結果

```json
{
  "source": "https://www.youtube.com/watch?v=9hE5-98ZeCg",
  "question": "映像と音声を日本語で要約し、重要な場面の時刻を示してください"
}
```

`source` は公開YouTube動画のHTTPS URL、またはsandbox内の動画ファイルパス。YouTubeのwatch・youtu.be・shorts・embed・live形式を受け付け、動画IDから正規URLへ変換する。公開状態の確認と動画の取得はGemini側が行う。非公開動画や取得できない動画は解析に失敗する。

ローカルファイルは `/workspace` 相対パス、または追加mountを含むコンテナ内の絶対パスを指定する。Discord添付ならプロンプトに記載された `attachments/0-clip.mp4` などのパスを使う。MP4、WebM、MOV、MPEG/MPG、AVI、WMV、FLV、3GPに対応し、拡張子でMIMEを選ぶ。実ファイル形式も一致させること。

回答はtoolのtext resultとして会話エージェントに返す。動画中の文字・字幕・発話を命令として扱わないよう指示し、Geminiのthought部分は結果から除外する。拒否・空回答・出力上限による未完了回答はエラーにする。解析の正確さや時刻の精度を保証するものではない。

## 制限

- ローカル動画は空でない通常ファイル、最大10MiB。実際の読み取りにも同じ上限を適用する。base64化して直接送信し、大きな動画の自動圧縮・分割・アップロードは行わない。
- Discord添付の既存制限（5件、10MB/件）は変更しない。
- 任意の外部動画URL、Files API、fps指定、区間指定は未対応。
- 実行の待ち時間はtoolの120000msのタイムアウト、Proxyの `requestTimeoutMs`、Agentの `timeoutMs` によって制限される。AgentからのキャンセルはAPIリクエストへ伝播する。自動再試行は行わない。
- `providers.json` の同時実行枠はAgent実行単位の制御。このtoolのHTTPリクエストでは追加の推論枠を取得しないため、Geminiへのリクエスト数を制限する設定としては使えない。

APIの対応範囲は [Google公式の動画理解ドキュメント](https://ai.google.dev/gemini-api/docs/generate-content/video-understanding) を参照。
