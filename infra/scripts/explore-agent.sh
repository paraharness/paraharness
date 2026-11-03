#!/usr/bin/env bash

readonly EXPLORE_MODEL=claude-haiku-5-5

explore_agent() {
  cd "$(git rev-parse --show-toplevel)"
  printf '%s\n' "$1" | claude -p --agent Explore --model "$EXPLORE_MODEL" --allowedTools Read Grep Glob "${@:2}"
}

librarian_agent() {
  cd "$(git rev-parse --show-toplevel)"
  claude -p --model "$EXPLORE_MODEL" --tools "" "$@"
}
