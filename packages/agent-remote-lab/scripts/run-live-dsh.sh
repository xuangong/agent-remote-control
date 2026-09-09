#!/usr/bin/env bash

set -euo pipefail

if [[ -n "${BORGEE_LIVE_DSH_PNPM:-}" ]]; then
  pnpm_candidate="$BORGEE_LIVE_DSH_PNPM"
elif pnpm_candidate="$(command -v pnpm)"; then
  :
else
  echo 'pnpm is required; set BORGEE_LIVE_DSH_PNPM or add pnpm to PATH.' >&2
  exit 2
fi
if [[ "$pnpm_candidate" != /* || ! -x "$pnpm_candidate" ]]; then
  echo 'BORGEE_LIVE_DSH_PNPM must resolve to an executable absolute path.' >&2
  exit 2
fi
readonly PNPM_BIN="$pnpm_candidate"

if [[ -n "${BORGEE_LIVE_DSH_GIT:-}" ]]; then
  git_candidate="$BORGEE_LIVE_DSH_GIT"
elif git_candidate="$(command -v git)"; then
  :
else
  echo 'git is required; set BORGEE_LIVE_DSH_GIT or add git to PATH.' >&2
  exit 2
fi
if [[ "$git_candidate" != /* || ! -x "$git_candidate" ]]; then
  echo 'BORGEE_LIVE_DSH_GIT must resolve to an executable absolute path.' >&2
  exit 2
fi
readonly GIT_BIN="$git_candidate"

if script_dir_candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"; then
  :
else
  status=$?
  echo 'Unable to resolve the live launcher directory.' >&2
  exit "$status"
fi
readonly SCRIPT_DIR="$script_dir_candidate"
if lab_root_candidate="$(cd "$SCRIPT_DIR/.." && pwd -P)"; then
  :
else
  status=$?
  echo 'Unable to resolve the Agent Remote Lab directory.' >&2
  exit "$status"
fi
readonly LAB_ROOT="$lab_root_candidate"

if [[ -n "${BORGEE_LIVE_DSH_NODE:-}" ]]; then
  node_candidate="$BORGEE_LIVE_DSH_NODE"
elif node_candidate="$(command -v node)"; then
  :
else
  echo 'node is required; set BORGEE_LIVE_DSH_NODE or add node to PATH.' >&2
  exit 2
fi
if [[ "$node_candidate" != /* || ! -x "$node_candidate" ]]; then
  echo 'BORGEE_LIVE_DSH_NODE must resolve to an executable absolute path.' >&2
  exit 2
fi
readonly NODE_BIN="$node_candidate"

manifest_candidate="${BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST:-$LAB_ROOT/compatibility.json}"
if [[ "$manifest_candidate" != /* || ! -f "$manifest_candidate" ]]; then
  echo 'BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST must resolve to an existing absolute file.' >&2
  exit 2
fi
readonly BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST="$manifest_candidate"
export BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST
if dsh_compatibility="$(
  cd "$LAB_ROOT" &&
    "$NODE_BIN" --import tsx/esm "$LAB_ROOT/src/server/compatibility-cli.ts"
)"; then
  :
else
  exit $?
fi
EXPECTED_DSH_COMMIT="${dsh_compatibility%%$'\n'*}"
EXPECTED_DSH_VERSION="${dsh_compatibility#*$'\n'}"
readonly EXPECTED_DSH_COMMIT EXPECTED_DSH_VERSION

if [[ -z "${DSH_REPO:-}" || "$DSH_REPO" != /* ]]; then
  echo 'DSH_REPO must name an explicit absolute DeepSeek Harness checkout.' >&2
  exit 2
fi
if [[ ! -f "$DSH_REPO/package.json" || ! -f "$DSH_REPO/apps/cli/src/bin.ts" ]]; then
  echo 'DSH_REPO does not look like a DeepSeek Harness source checkout.' >&2
  exit 2
fi
if resolved_dsh_candidate="$(cd "$DSH_REPO" && pwd -P)"; then
  :
else
  status=$?
  echo 'Unable to enter DSH_REPO.' >&2
  exit "$status"
fi
readonly RESOLVED_DSH_REPO="$resolved_dsh_candidate"
actual_dsh_version="$($NODE_BIN -e '
const fs = require("node:fs");
try {
  const packageJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof packageJson.version !== "string") throw new Error("missing package version");
  process.stdout.write(packageJson.version);
} catch (error) {
  process.stderr.write(`Unable to read DSH package version: ${error.message}\n`);
  process.exit(2);
}
' "$RESOLVED_DSH_REPO/package.json")"
if [[ "$actual_dsh_version" != "$EXPECTED_DSH_VERSION" ]]; then
  echo "DSH_REPO must report version $EXPECTED_DSH_VERSION; got ${actual_dsh_version:-unknown}." >&2
  exit 2
fi
actual_dsh_commit="$($GIT_BIN -C "$RESOLVED_DSH_REPO" rev-parse HEAD 2>/dev/null || true)"
if [[ "$actual_dsh_commit" != "$EXPECTED_DSH_COMMIT" ]]; then
  echo "DSH_REPO must be checkout $EXPECTED_DSH_COMMIT; got ${actual_dsh_commit:-unknown}." >&2
  exit 2
fi
if temp_root_candidate="$(cd "${TMPDIR:-/tmp}" && pwd -P)"; then
  :
else
  status=$?
  echo 'Unable to resolve the temporary-directory root.' >&2
  exit "$status"
fi
readonly TEMP_ROOT="$temp_root_candidate"

AGENT_WORKSPACE=''
PLUGIN_BUILD=''
DSH_PID=''
readonly AGENT_WORKSPACE_PREFIX="$TEMP_ROOT/borgee-live-dsh-workspace."
readonly PLUGIN_BUILD_PREFIX="$LAB_ROOT/.live-dsh-build."

cleanup_owned_directory() {
  local directory="$1"
  local prefix="$2"
  if [[ -n "$directory" && "$directory" == "$prefix"?* && -d "$directory" ]]; then
    rm -rf -- "$directory"
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$DSH_PID" ]] && kill -0 "$DSH_PID" 2>/dev/null; then
    kill -TERM "$DSH_PID" 2>/dev/null || true
    wait "$DSH_PID" 2>/dev/null || true
  fi
  cleanup_owned_directory "$PLUGIN_BUILD" "$PLUGIN_BUILD_PREFIX"
  cleanup_owned_directory "$AGENT_WORKSPACE" "$AGENT_WORKSPACE_PREFIX"
  exit "$status"
}

if agent_workspace_candidate="$(mktemp -d "$AGENT_WORKSPACE_PREFIX"XXXXXX)"; then
  :
else
  status=$?
  echo 'Unable to create the live DSH workspace.' >&2
  exit "$status"
fi
if [[ "$agent_workspace_candidate" != "$AGENT_WORKSPACE_PREFIX"?* || ! -d "$agent_workspace_candidate" ]]; then
  cleanup_owned_directory "$agent_workspace_candidate" "$AGENT_WORKSPACE_PREFIX"
  echo 'mktemp returned an invalid live DSH workspace.' >&2
  exit 2
fi
AGENT_WORKSPACE="$agent_workspace_candidate"
readonly AGENT_WORKSPACE
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if plugin_build_candidate="$(mktemp -d "$PLUGIN_BUILD_PREFIX"XXXXXX)"; then
  :
else
  status=$?
  echo 'Unable to create the live plugin build directory.' >&2
  exit "$status"
fi
if [[ "$plugin_build_candidate" != "$PLUGIN_BUILD_PREFIX"?* || ! -d "$plugin_build_candidate" ]]; then
  cleanup_owned_directory "$plugin_build_candidate" "$PLUGIN_BUILD_PREFIX"
  echo 'mktemp returned an invalid live plugin build directory.' >&2
  exit 2
fi
PLUGIN_BUILD="$plugin_build_candidate"
readonly PLUGIN_BUILD

unset NO_COLOR
printf '%s\n' 'live-dsh-fixture-content' > "$AGENT_WORKSPACE/live-fixture.txt"

"$PNPM_BIN" --dir "$LAB_ROOT" --filter @borgee/agent-provider-dsh run build
"$PNPM_BIN" --dir "$LAB_ROOT" --filter @agent-remote-control/dsh run build

"$PNPM_BIN" --dir "$LAB_ROOT" exec tsc \
  --target ES2022 \
  --module ESNext \
  --moduleResolution bundler \
  --lib ES2022 \
  --types node \
  --strict \
  --noUncheckedIndexedAccess \
  --skipLibCheck \
  --isolatedModules \
  --rootDir "$LAB_ROOT/src" \
  --outDir "$PLUGIN_BUILD" \
  "$LAB_ROOT/src/server/live-plugin.ts"

cp "$LAB_ROOT/live-dsh.patch.yml" "$AGENT_WORKSPACE/live-dsh.runtime.patch.yml"
printf '%s\n' \
  '' \
  '- insert:' \
  '    - id: borgee-agent-remote-live' \
  "      name: $PLUGIN_BUILD/server/live-plugin.js" \
  >> "$AGENT_WORKSPACE/live-dsh.runtime.patch.yml"

(
  cd "$AGENT_WORKSPACE"
  BORGEE_LIVE_DSH_SESSION_ROOT="$AGENT_WORKSPACE/.sessions" \
  BORGEE_LIVE_DSH_WORKSPACE="$AGENT_WORKSPACE" \
  DSH_TOOLS_MODE='native' \
  TSX_TSCONFIG_PATH="$RESOLVED_DSH_REPO/tsconfig.json" \
    "$PNPM_BIN" --dir "$RESOLVED_DSH_REPO" dsh --profile headless --patch "$AGENT_WORKSPACE/live-dsh.runtime.patch.yml"
) &
DSH_PID=$!
wait "$DSH_PID"
