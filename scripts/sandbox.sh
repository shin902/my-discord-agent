#!/usr/bin/env bash
set -euo pipefail

REGISTRY_CONTAINER="my-discord-agent-registry"
REGISTRY_PORT=5050
IMAGE="localhost:${REGISTRY_PORT}/my-discord-agent-runner:latest"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { echo -e "${BLUE}[sandbox]${NC} $1"; }
ok()   { echo -e "${GREEN}[sandbox]${NC} $1"; }
warn() { echo -e "${YELLOW}[sandbox]${NC} $1"; }
err()  { echo -e "${RED}[sandbox]${NC} $1" >&2; }

registry_running() {
  # コンテナ名ではなくポートで判定（別名の既存レジストリも正常扱い）
  docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":${REGISTRY_PORT}->"
}

registry_container_name() {
  docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
    | grep ":${REGISTRY_PORT}->" | awk '{print $1}' | head -1
}

cmd_registry_start() {
  if registry_running; then
    ok "レジストリはすでに起動中 (localhost:${REGISTRY_PORT})"
    return 0
  fi
  # 停止済みコンテナが残っていれば削除
  if docker ps -a --filter "name=^/${REGISTRY_CONTAINER}$" --format '{{.Names}}' | grep -q "^${REGISTRY_CONTAINER}$"; then
    info "停止済みのコンテナを削除..."
    docker rm "${REGISTRY_CONTAINER}" > /dev/null
  fi
  info "レジストリを起動します (localhost:${REGISTRY_PORT})..."
  docker run -d \
    --name "${REGISTRY_CONTAINER}" \
    --restart unless-stopped \
    -p "${REGISTRY_PORT}:5000" \
    registry:2 > /dev/null
  ok "レジストリ起動完了"
}

cmd_registry_stop() {
  if ! registry_running; then
    warn "レジストリは起動していません"
    return 0
  fi
  local name
  name="$(registry_container_name)"
  info "レジストリを停止します (${name})..."
  docker stop "${name}" > /dev/null
  ok "停止しました"
}

cmd_registry_status() {
  if registry_running; then
    ok "レジストリ: 起動中 (localhost:${REGISTRY_PORT})"
  else
    warn "レジストリ: 停止中"
  fi
}

cmd_build() {
  if ! registry_running; then
    warn "レジストリが起動していません。自動で起動します..."
    cmd_registry_start
  fi

  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "${root}"

  info "1/3: esbuild でバンドル..."
  pnpm build:runner

  info "2/3: Docker イメージをビルド..."
  docker build -t "${IMAGE}" .

  info "3/3: レジストリにプッシュ..."
  docker push "${IMAGE}"

  ok "ビルド完了: ${IMAGE}"
}

cmd_status() {
  cmd_registry_status
  if docker image inspect "${IMAGE}" > /dev/null 2>&1; then
    local created
    created=$(docker image inspect "${IMAGE}" --format '{{.Created}}' | cut -dT -f1)
    ok "Runner イメージ: あり (${created})"
  else
    warn "Runner イメージ: なし（未ビルド）"
  fi
}

cmd_logs() {
  if ! registry_running; then
    err "レジストリが起動していません"
    exit 1
  fi
  local name follow
  name="$(registry_container_name)"
  follow="${1:-}"
  if [ "${follow}" = "-f" ]; then
    docker logs -f "${name}"
  else
    docker logs --tail 50 "${name}"
  fi
}

cmd_clean() {
  info "クリーンアップを開始..."
  if docker image inspect "${IMAGE}" > /dev/null 2>&1; then
    info "ローカルイメージを削除: ${IMAGE}"
    docker rmi "${IMAGE}" || true
  fi
  local dangling
  dangling=$(docker images -f "dangling=true" -q 2>/dev/null || true)
  if [ -n "${dangling}" ]; then
    info "未使用イメージを削除..."
    # shellcheck disable=SC2086
    docker rmi ${dangling} || true
  fi
  ok "クリーンアップ完了"
}

usage() {
  cat <<EOF
使い方: pnpm sandbox <コマンド>

コマンド:
  build             Runner イメージをビルドしてレジストリにプッシュ
  status            レジストリとイメージの状態を確認
  logs              レジストリのログを表示（直近50行）
  logs -f           レジストリのログをフォロー表示
  registry start    ローカルレジストリを起動（初回セットアップ・再起動後に）
  registry stop     ローカルレジストリを停止
  registry status   レジストリの状態だけ確認
  clean             ローカルの Runner イメージを削除

よくある手順:
  初回セットアップ:  pnpm sandbox registry start
  コード変更後:      pnpm sandbox build
  状態確認:          pnpm sandbox status
EOF
}

case "${1:-help}" in
  build)    cmd_build ;;
  status)   cmd_status ;;
  logs)     cmd_logs "${2:-}" ;;
  clean)    cmd_clean ;;
  help)     usage ;;
  registry)
    case "${2:-}" in
      start)  cmd_registry_start ;;
      stop)   cmd_registry_stop ;;
      status) cmd_registry_status ;;
      *) err "不明なサブコマンド: registry ${2:-}"; echo; usage; exit 1 ;;
    esac
    ;;
  *) err "不明なコマンド: ${1}"; echo; usage; exit 1 ;;
esac
