#!/usr/bin/env bash
set -euo pipefail

workspace="${1:-/workspace}"
template_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/templates" && pwd)"

mkdir -p "$workspace/memory/system"

copy_missing() {
  local source="$1"
  local destination="$2"
  if (set -o noclobber; cat "$source" > "$destination") 2>/dev/null; then
    echo "created: ${destination#"$workspace/"}"
  elif [[ -e "$destination" || -L "$destination" ]]; then
    echo "kept: ${destination#"$workspace/"}"
  else
    echo "failed to create: ${destination#"$workspace/"}" >&2
    return 1
  fi
}

copy_missing "$template_dir/index.md" "$workspace/memory/index.md"
copy_missing "$template_dir/system/index.md" "$workspace/memory/system/index.md"
copy_missing "$template_dir/system/definition.md" "$workspace/memory/system/definition.md"
