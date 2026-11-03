#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
. "$root/infra/scripts/gate-env.sh"
log="$logdir/check-$(date -u +%Y%m%dT%H%M%SZ).log"
status=0
env -u NODE_USE_ENV_PROXY NODE_NO_WARNINGS=1 SWC_NATIVE_BINDING_CACHE="$cache" \
  node "$root/infra/scripts/check-touched.mjs" "$@" 2>&1 | tee "$log" || status=$?
echo "check: log $log"
exit "$status"
