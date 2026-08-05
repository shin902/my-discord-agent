# systemdサービス設定

`service.sh` を使って systemd ユーザーサービスとして常駐起動できる。

## 前提

ログアウト後も動作させるためにlingeringを有効化しておく:

```bash
loginctl enable-linger $USER
```

## セットアップ

```bash
./service.sh setup
./service.sh start
```

`setup` はリポジトリ内の `my-discord-agent.service` を `~/.config/systemd/user/` にコピーし、`enable` まで行う。次回ログイン（またはOS起動）時から自動起動される。

## 操作

```bash
./service.sh start    # 起動
./service.sh stop     # 停止
./service.sh restart  # 再起動
./service.sh status   # 状態確認
./service.sh log      # リアルタイムログ (Ctrl+C で終了)
```

## サービスファイルの変更

`my-discord-agent.service` を編集した後は再セットアップが必要:

```bash
./service.sh setup
./service.sh restart
```
