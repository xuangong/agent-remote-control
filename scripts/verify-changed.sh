#!/bin/sh
# Checks what a task changed, on demand: builds and type-checks the changed packages and their dependents, then runs the
# unit tests of each changed module of architecture/modules.json with the seam suites the module names (`pnpm test:changed`;
# scripts/lib/test-selection.mjs). The unit tests of modules that import a changed module run too when they reach the changed file
# (nearest first, at most 80 files); the full `pnpm verify` runs everything at the end of a step. Files outside packages/ run nothing, except that scripts/**/*.test.mjs
# changed run alone and a change to the root package.json, the lockfile or the workspace file runs the full `pnpm verify`,
# as releases do.
# The compatibility digest is not checked here: task branches never update it, and `pnpm postmerge` checks it on main.
# Usage: pnpm verify:changed [base-commit]
# The base is, in order: the argument, $ARC_TASK_BASE, the commit `pnpm task:start` recorded, the merge base with origin/main.
cd "$(git rev-parse --show-toplevel)" || exit 1
# Tests that run git in temporary repositories must not inherit this repository's GIT_DIR (set in hooks and worktrees).
unset $(git rev-parse --local-env-vars)
recorded=$(cat "$(git rev-parse --git-path arc-task-base)" 2>/dev/null)
base=${1:-${ARC_TASK_BASE:-${recorded:-$(git merge-base HEAD origin/main 2>/dev/null)}}}
if [ -z "$base" ]; then echo 'verify:changed: no base commit and no merge base with origin/main; running pnpm verify.' >&2; exec pnpm verify; fi
base=$(git rev-parse --verify --quiet "$base^{commit}") || { echo 'verify:changed: the base is not a commit.' >&2; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo 'verify:changed: uncommitted changes are built, but only committed ones choose the packages to test.' >&2
fi
changed=$(git diff --name-only "$base" HEAD)
if printf '%s\n' "$changed" | grep -qE '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$'; then
  echo "verify:changed: the root package.json, lockfile or workspace file changed since $(git rev-parse --short "$base"); running pnpm verify." >&2
  exec pnpm verify
fi
echo "verify:changed: building the packages changed since $(git rev-parse --short "$base") and their dependents, then testing the changed modules." >&2
script_tests=$(printf '%s\n' "$changed" | grep -E '^scripts/.*\.test\.mjs$' | while read -r file; do [ -f "$file" ] && echo "$file"; done)
node scripts/run-tests.mjs affected-build "$base" && node scripts/run-tests.mjs affected-typecheck "$base" && node scripts/run-tests.mjs changed "$base" || exit 1
if [ -n "$script_tests" ]; then
  echo "verify:changed: running the changed script tests." >&2
  # shellcheck disable=SC2086
  exec node --test --test-timeout=60000 $script_tests
fi
