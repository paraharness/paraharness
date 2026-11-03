#!/usr/bin/env bash
uid="$(id -u)"
shared_tmp="${GATE_SHARED_TMP:-/tmp}"
writable_by_others=8#022
sticky=8#1000

trusted_dir() {
  local dir mode owner
  dir="$(cd "$1" 2>/dev/null && pwd -P)" || return 1
  while :; do
    read -r mode owner < <(stat -c '%a %u' "$dir")
    if (( 8#$mode & writable_by_others )) && ! { (( 8#$mode & sticky )) && { [ "$owner" = 0 ] || [ "$owner" = "$uid" ]; }; }; then
      return 1
    fi
    [ "$dir" = / ] && return 0
    dir="$(dirname "$dir")"
  done
}

cache="${SWC_NATIVE_BINDING_CACHE:-}"
if [ -z "$cache" ]; then
  swc_root="$shared_tmp"
  if [ -n "${TMPDIR:-}" ] && trusted_dir "$TMPDIR"; then
    swc_root="$TMPDIR"
  fi
  swc_parent="$swc_root/swc-binding-$uid"
  mkdir -p "$swc_parent"
  chmod 700 "$swc_parent"
  cache="$swc_parent/cache"
fi
mkdir -p "$cache"
chmod 700 "$cache"
logdir="${GATE_LOG_DIR:-${TMPDIR:-/tmp}/gate-logs-$(id -u)}"
mkdir -p "$logdir"
