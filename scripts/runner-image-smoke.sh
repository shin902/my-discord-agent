#!/usr/bin/env bash
set -euo pipefail

image="${RUNNER_IMAGE:-my-discord-agent-runner:smoke}"
fallback_image="${RUNNER_IMAGE_FALLBACK:-${image}-source-fallback}"
pnpm build:runner

normal_build_log="$(mktemp)"
fallback_build_log=""
cleanup() {
  rm -f "$normal_build_log"
  if [[ -n "$fallback_build_log" ]]; then
    rm -f "$fallback_build_log"
  fi
}
trap cleanup EXIT
# Keep the build log so this smoke test can detect an accidental native
# rebuild in the default (prebuilt) installation path. The lifecycle command
# always contains `node-gyp rebuild` as its fallback, so inspect node-gyp's
# actual diagnostic output rather than that command declaration.
docker build --no-cache -t "$image" . 2>&1 | tee "$normal_build_log"
if grep -Eqi 'gyp (info|err)|node-gyp rebuild.*(failed|error)' "$normal_build_log"; then
  echo "better-sqlite3 unexpectedly rebuilt from source in the normal image build" >&2
  exit 1
fi

timezone_output="$(docker run --rm "$image" sh -c 'printf "%s\n" "$TZ"; date +%Z')"
printf '%s\n' "$timezone_output"
grep -qx 'Asia/Tokyo' <<<"$timezone_output"
grep -qx 'JST' <<<"$timezone_output"

sqlite_output="$(docker run --rm "$image" node --input-type=commonjs -e '
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.prepare("select 1 as value").get();
  db.close();
  console.log("__BETTER_SQLITE3_LOAD_OK__");
')"
printf '%s\n' "$sqlite_output"
grep -qx '__BETTER_SQLITE3_LOAD_OK__' <<<"$sqlite_output"

output="$({ docker run --rm \
  -e SESSIONS_DIR=/tmp/sessions \
  "$image" node /app/runner.mjs --session-store-smoke; } 2>&1)"
printf '%s\n' "$output"
grep -q '^__AGENT_READY__$' <<<"$output"
grep -q '^__SESSION_STORE_SMOKE_OK__$' <<<"$output"

# A source-forced build is the deterministic equivalent of a missing prebuilt
# asset. It verifies that the retained native toolchain still provides the
# documented fallback path.
fallback_build_log="$(mktemp)"
docker build --no-cache \
  --build-arg RUNNER_SQLITE_BUILD_FROM_SOURCE=true \
  -t "$fallback_image" . 2>&1 | tee "$fallback_build_log"
grep -Eqi 'gyp info|gyp err' "$fallback_build_log"
fallback_sqlite_output="$(docker run --rm "$fallback_image" node --input-type=commonjs -e '
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.prepare("select 1 as value").get();
  db.close();
  console.log("__BETTER_SQLITE3_SOURCE_FALLBACK_OK__");
')"
printf '%s\n' "$fallback_sqlite_output"
grep -qx '__BETTER_SQLITE3_SOURCE_FALLBACK_OK__' <<<"$fallback_sqlite_output"
