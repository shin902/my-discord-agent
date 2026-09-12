#!/usr/bin/env bash
set -euo pipefail

workspace="${1:-/workspace}"
template_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/templates" && pwd)"

mkdir -p "$workspace/memory/system"

copy_missing() {
  local source="$1"
  local destination="$2"
  if [[ ! -e "$destination" && ! -L "$destination" ]]; then
    cp "$source" "$destination"
    echo "created: ${destination#"$workspace/"}"
  else
    echo "kept: ${destination#"$workspace/"}"
  fi
}

copy_missing "$template_dir/index.md" "$workspace/memory/index.md"
copy_missing "$template_dir/system/index.md" "$workspace/memory/system/index.md"
copy_missing "$template_dir/system/definition.md" "$workspace/memory/system/definition.md"
