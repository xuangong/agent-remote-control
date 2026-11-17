#!/bin/sh
# Records the current commit as the base of this task, so `pnpm verify:changed` tests only what the task changes.
cd "$(git rev-parse --show-toplevel)" || exit 1
git rev-parse HEAD > "$(git rev-parse --git-path arc-task-base)" && echo "Task base: $(git rev-parse --short HEAD)"
