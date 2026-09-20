#!/bin/sh
set -eu
ulimit -Sn "${AGENT_HOST_CODEX_NOFILE:-8192}"
exec node /opt/controller/entrypoint.mjs "$@"
