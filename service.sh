#!/bin/bash
set -e

SERVICE=my-discord-agent
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

case "${1:-}" in
  setup)
    mkdir -p "$SYSTEMD_USER_DIR"
    cat > "$SYSTEMD_USER_DIR/$SERVICE.service" <<EOF
[Unit]
Description=My Discord Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
ExecStart=/usr/bin/mise exec -- pnpm start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable $SERVICE
    sudo loginctl enable-linger "$USER"
    echo "セットアップ完了。'$0 start' で起動できます。"
    ;;
  start)   systemctl --user start   $SERVICE ;;
  stop)    systemctl --user stop    $SERVICE ;;
  restart) systemctl --user restart $SERVICE ;;
  status)  systemctl --user status  $SERVICE --no-pager ;;
  log)     journalctl --user -u $SERVICE -f ;;
  *)
    echo "Usage: $0 {setup|start|stop|restart|status|log}"
    exit 1
    ;;
esac
