#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/explore-agent.sh"

usage() {
  echo 'usage: pnpm explore [--file <path>] "<question>"' >&2
  exit 2
}

file=""
if [ "${1:-}" = "--file" ]; then
  [ $# -eq 3 ] && [ -f "$2" ] || usage
  file="$2"
  shift 2
fi
question="${1:-}"
if [ $# -ne 1 ] || [ -z "$question" ]; then
  usage
fi

memory="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/.memory"
scope=""
[ -n "$file" ] && scope="The question is about one file, $file: Grep it and Read it in ranges, and answer from it alone.
"

explore_agent "Answer the question below about this repository and its memory checkout in your two sections, and nothing else:
FACTS: only the lines that answer it, one per line as path:line followed by the line.
NOT FOUND: what you looked for and could not find, or none.
The memory checkout is $memory. The archives, $memory/archive/ and $memory/tasks/archive/, are read only when the question is whether a decision was already made.
${scope}Read only; change nothing.

The question:

$question"
