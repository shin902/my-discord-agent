#!/usr/bin/env bash
# wiki-setup/setup.sh
# Usage: bash setup.sh <WIKI_ROOT> <RAW_DIR> <DIGEST_DIR>
# Example: bash setup.sh llm-wiki llm-wiki/raw llm-wiki/digest
#
# Copies bundled skill templates to /workspace/SKILLS/ and substitutes placeholders.
# Skips any skill directory that already exists (non-destructive).

set -euo pipefail

WIKI_ROOT="${1:?WIKI_ROOT required (e.g. llm-wiki)}"
RAW_DIR="${2:?RAW_DIR required (e.g. llm-wiki/raw)}"
DIGEST_DIR="${3:?DIGEST_DIR required (e.g. llm-wiki/digest)}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/SKILLS"
DEST_DIR="/workspace/SKILLS"

mkdir -p "$DEST_DIR"

for skill_src in "$SRC_DIR"/*/; do
  skill_name="$(basename "$skill_src")"
  skill_dest="$DEST_DIR/$skill_name"

  if [ -d "$skill_dest" ]; then
    echo "skip: $skill_name (already exists)"
    continue
  fi

  trap 'rm -rf "$skill_dest"' ERR
  cp -r "$skill_src" "$skill_dest"

  python3 - "$skill_dest" "$WIKI_ROOT" "$RAW_DIR" "$DIGEST_DIR" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
replacements = dict(zip(('WIKI_ROOT', 'RAW_DIR', 'DIGEST_DIR'), sys.argv[2:]))
for path in root.rglob('*.md'):
    text = path.read_text()
    for name, value in replacements.items():
        text = text.replace('{{' + name + '}}', value)
    path.write_text(text)
PY
  trap - ERR

  echo "installed: $skill_name"
done

echo "done. skills installed to $DEST_DIR"
