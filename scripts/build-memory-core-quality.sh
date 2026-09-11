#!/usr/bin/env bash
set -euo pipefail

# Build a reproducible MemoryCore image with the small L1→L2 metadata patch.
# The default official image remains unchanged; set MEMORY_CORE_IMAGE to the
# resulting tag before starting compose.
readonly REPOSITORY="${TDAI_MEMORY_CORE_REPOSITORY:-https://github.com/TencentCloud/TencentDB-Agent-Memory.git}"
readonly REF="${TDAI_MEMORY_CORE_REF:-feat/server_team}"
readonly COMMIT="${TDAI_MEMORY_CORE_COMMIT:-0468a2a5b50eaafc54758ed1e2e6609472e5b6ce}"
readonly IMAGE="${MEMORY_CORE_IMAGE:-my-discord-agent-memory-core:quality}"
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly PATCH_FILE="${PROJECT_ROOT}/patches/tencentdb-memory-core-activity-metadata.patch"
readonly BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/memory-core-quality.XXXXXX")"

cleanup() {
  rm -rf "${BUILD_DIR}"
}
trap cleanup EXIT

if [[ ! -f "${PATCH_FILE}" ]]; then
  echo "Missing upstream patch: ${PATCH_FILE}" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "Docker Buildx is required because the upstream MemoryCore Dockerfile uses BuildKit mounts" >&2
  exit 1
fi

# Fetch the named branch with a shallow, blob-filtered checkout, then verify
# the exact commit before applying the patch. A moved branch fails closed.
git init -q "${BUILD_DIR}/source"
git -C "${BUILD_DIR}/source" remote add origin "${REPOSITORY}"
git -C "${BUILD_DIR}/source" fetch --depth 1 --filter=blob:none origin "${REF}"
git -C "${BUILD_DIR}/source" checkout -q --detach FETCH_HEAD
actual_commit="$(git -C "${BUILD_DIR}/source" rev-parse HEAD)"
if [[ "${actual_commit}" != "${COMMIT}" ]]; then
  echo "Upstream ref ${REF} resolved to ${actual_commit}, expected ${COMMIT}" >&2
  exit 1
fi

# The tracked patch uses zero context to avoid nested-patch whitespace noise;
# the exact commit check above makes this application deterministic.
git -C "${BUILD_DIR}/source" apply --unidiff-zero --check "${PATCH_FILE}"
git -C "${BUILD_DIR}/source" apply --unidiff-zero "${PATCH_FILE}"

expected_files=$'MemoryCore/src/core/prompts/scene-extraction.ts\nMemoryCore/src/core/scene/scene-extractor.ts\nMemoryCore/src/utils/pipeline-factory.ts'
actual_files="$(git -C "${BUILD_DIR}/source" diff --name-only)"
if [[ "${actual_files}" != "${expected_files}" ]]; then
  echo "Upstream patch changed an unexpected file set:" >&2
  printf '%s\n' "${actual_files}" >&2
  exit 1
fi

DOCKER_BUILDKIT=1 docker build \
  --tag "${IMAGE}" \
  --file "${BUILD_DIR}/source/MemoryCore/Dockerfile" \
  "${BUILD_DIR}/source"

echo "Built ${IMAGE} from ${REPOSITORY}@${COMMIT} with activity metadata patch"
