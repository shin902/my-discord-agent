---
name: md2html
description: "Markdown ファイルをオフライン完結の単一 HTML ファイルに変換するスキル。pip install md2html-phuker で利用可能。"
---

# md2html スキル

Markdown ファイルを、CDN・外部 JS 依存なしで完全自己完結型の単一 HTML ファイルに変換する。

## インストール確認

```bash
python3 -m md2html --version 2>/dev/null || pip install md2html-phuker
```

## 変換コマンド

```bash
# 基本変換（同ディレクトリに input.html を生成）
md2html input.md

# 出力ファイル名を指定
md2html -o /workspace/output.html input.md

# スタイル指定
md2html --style dark input.md        # ダークテーマ
md2html --style sidebar input.md     # サイドバー目次付き

# 利用可能なスタイル一覧
md2html --list-styles
```

## 制約

- Python 3 が必要。`python3 -m md2html` または `md2html` コマンドで実行する
- 入力はファイルパス（stdin 不可）
- ローカル画像は参照のみ（HTML に埋め込まれない）
- 変換後のファイルはそのままブラウザで開ける完全スタンドアローン HTML
