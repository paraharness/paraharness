#!/usr/bin/env bash

memory_checkout() {
  local top
  if [ -n "${MEMORY_DIR:-}" ]; then
    printf '%s\n' "$MEMORY_DIR"
    return 0
  fi
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || return 1
  if [ "$(basename "$top")" = .memory ]; then
    printf '%s\n' "$top"
  else
    printf '%s/.memory\n' "$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
  fi
}
