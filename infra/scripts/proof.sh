#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
. "$root/infra/scripts/gate-env.sh"
exec env -u NODE_USE_ENV_PROXY SWC_NATIVE_BINDING_CACHE="$cache" node "$root/infra/verify/proof.mjs" "$@"
