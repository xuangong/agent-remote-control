#!/bin/sh
# Checks what this branch changes against origin/main, on demand: the compatibility check, the full build and type
# check, and the unit suites of the changed packages and of the packages that depend on them. Changes to workspace
# files outside packages/ and docs/, such as scripts or the lockfile, run the full `pnpm verify`, as releases do.
# Pushing does not run these checks; run this before a push or a merge when you want them.
# Usage: pnpm verify:changed [base-commit]   (default: the merge base with origin/main)
cd "$(git rev-parse --show-toplevel)" || exit 1
# Tests that run git in temporary repositories must not inherit this repository's GIT_DIR (set in hooks and worktrees).
unset $(git rev-parse --local-env-vars)
base=${1:-$(git merge-base HEAD origin/main 2>/dev/null)}
if [ -z "$base" ]; then echo 'verify:changed: no merge base with origin/main; running pnpm verify.' >&2; exec pnpm verify; fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo 'verify:changed: uncommitted changes are built, but only committed ones choose the packages to test.' >&2
fi
if git diff --name-only "$base" HEAD | grep -qvE '^(packages|docs)/'; then
  echo "verify:changed: files outside packages/ and docs/ changed since $(git rev-parse --short "$base"); running pnpm verify." >&2
  exec pnpm verify
fi
echo "verify:changed: testing the packages changed since $(git rev-parse --short "$base") and their dependents." >&2
pnpm compatibility:check && pnpm -r run build && pnpm typecheck && exec node scripts/run-tests.mjs affected "$(git rev-parse "$base")"
