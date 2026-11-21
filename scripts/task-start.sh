#!/bin/sh
# Records the current commit as the base of this task, so `pnpm verify:changed` tests only what the task changes, and registers
# the repository's merge driver (scripts/git-setup.mjs), which git does not keep in versioned configuration.
cd "$(git rev-parse --show-toplevel)" || exit 1
node scripts/git-setup.mjs
git rev-parse HEAD > "$(git rev-parse --git-path arc-task-base)" && echo "Task base: $(git rev-parse --short HEAD)"
