#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C.UTF-8

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$here/memory-dir.sh"
source "$here/../../infra/scripts/explore-agent.sh"

readonly CAP=20
readonly MAX_CHARS=500
readonly ORDER=(shared HEAD CONSULTANT BUILDER REVIEWER VERIFIER JUDGE DESIGNER HOTFIX EXPLORE SCRIBE)
declare -rA LETTER=([shared]=A [HEAD]=H [CONSULTANT]=C [BUILDER]=B [REVIEWER]=R [VERIFIER]=V [JUDGE]=J [DESIGNER]=G [HOTFIX]=X [EXPLORE]=E [SCRIBE]=S)
declare -A FILE_OF=()
for name in "${ORDER[@]}"; do
  FILE_OF[${LETTER[$name]}]="$name"
done
readonly ONE_ID="[${LETTER[*]// /}][0-9]+"
readonly ID_RE="^$ONE_ID$"
readonly IDS_RE="^$ONE_ID(,$ONE_ID)*$"

say() {
  if [ -n "${2:-}" ]; then
    printf '%-11s  %s\n' "$1" "$2"
  else
    printf '%s\n' "$1"
  fi
}

usage() {
  say NEXT 'wrong arguments: run pnpm lesson <FILE> [--replace <id> | --distinct <id>[,<id>…]] "<sentence>" or pnpm lesson <FILE> --remove <id>' >&2
  exit 2
}

refuse() {
  say NEXT "$1"
  exit 1
}

check_failed() {
  refuse "lesson check failed ($(awk 'NF { print; exit }' <<<"$1")): rerun"
}

path_of() {
  if [ "$1" = shared ]; then
    echo LESSONS.md
  else
    echo "lessons/$1.md"
  fi
}

lesson_lines() {
  [ ! -f "$1" ] || grep -E '^- [A-Z][0-9]+: ' "$1" || true
}

form_lines() {
  grep -vE '^- [A-Z][0-9]+: |^[[:space:]]*$' "$1" | sed -E 's/^(Good|Bad):([[:space:]]+)- [A-Z][0-9]+: /\1:\2/' || true
}

text_of() {
  local id="$1"
  sed -n "s/^- $id: //p" "$memory/$(path_of "${FILE_OF[${id:0:1}]}")"
}

check_form() {
  if [[ "$1" == *$'\n'* || "$1" != *[^.]. || "$1" =~ [.!?][[:space:]] ]]; then
    refuse "not one sentence ending in one period: write it as one sentence that ends in one period"
  fi
  [[ "$1" == *" because "* ]] || refuse "no because: name the mechanism that bites after because"
  if [[ "$1" =~ [0-9]{4}-[0-9]{2}-[0-9]{2} ]]; then
    refuse "carries a date (${BASH_REMATCH[0]}): drop it"
  fi
  if [[ "$1" =~ (CD|TIC)-[0-9]+ ]]; then
    refuse "carries a ticket id (${BASH_REMATCH[0]}): drop it"
  fi
  if [[ "$1" =~ \#[0-9]+ ]]; then
    refuse "carries a PR number (${BASH_REMATCH[0]}): drop it"
  fi
  [[ "$1" != *[\"“”„«»]* ]] || refuse "carries quotation marks: drop them"
  [ "${#1}" -lt "$MAX_CHARS" ] || refuse "${#1} characters, $MAX_CHARS or more: cut it under $MAX_CHARS"
}

[ $# -ge 2 ] || usage
file="$1"
shift
[ -n "${LETTER[$file]:-}" ] || usage
letter="${LETTER[$file]}"
name="$file"
[ "$file" != shared ] || name=LESSONS.md
replace=
distinct=
remove=
sentence=
if [ "$1" = --remove ]; then
  [ $# -eq 2 ] && [[ "$2" =~ $ID_RE ]] || usage
  remove="$2"
else
  while [ $# -gt 1 ]; do
    [ -z "$replace$distinct" ] && [ $# -gt 2 ] || usage
    case "$1" in
      --replace)
        [[ "$2" =~ $ID_RE ]] || usage
        replace="$2"
        ;;
      --distinct)
        [[ "$2" =~ $IDS_RE ]] || usage
        distinct="$2"
        ;;
      *) usage ;;
    esac
    shift 2
  done
  sentence="$1"
  check_form "$sentence"
fi

memory="$(memory_checkout)" || refuse "no memory checkout $PWD: run from the main checkout or a worktree, or set MEMORY_DIR"
git_dir="$(git -C "$memory" rev-parse --path-format=absolute --git-dir 2>/dev/null)" || refuse "no memory checkout $memory: run from the main checkout or a worktree, or set MEMORY_DIR"
path="$(path_of "$file")"
target="$memory/$path"
[ -f "$target" ] || refuse "no $path in $memory: check the memory checkout"

lock="$git_dir/lesson.lock"
exec 8>"$lock"
flock -n 8 || refuse "another lesson run holds $lock: rerun when it ends"

named="$replace$remove"
if [ -n "$named" ]; then
  grep -q "^- $named: " "$target" || refuse "no $named in $name: name an id the file holds"
fi

lessons() {
  local name
  awk 'fence >= 2 { print } /^---$/ { fence++ }' "$here/../agents/lesson-check.md"
  printf '\n'
  for name in "${ORDER[@]}"; do
    printf '## %s\n' "$(path_of "$name")"
    lesson_lines "$memory/$(path_of "$name")"
    printf '\n'
  done
}

candidate() {
  printf '## Form rules of %s\n' "$path"
  form_lines "$target"
  printf '\nCandidate for %s:\n%s\n' "$path" "$sentence"
}

ask_agent() {
  candidate | librarian_agent --system-prompt "$(lessons)"
}

parse() {
  local -a reply files=()
  local i=0 id line
  mapfile -t reply < <(awk 'NF { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print }' <<<"$1")
  ids=()
  report=()
  if [ "${reply[0]:-}" = NONE ]; then
    i=1
  else
    while [ "$i" -lt "${#reply[@]}" ] && [[ "${reply[$i]}" =~ ^SIMILAR\ +($ONE_ID)$ ]]; do
      id="${BASH_REMATCH[1]}"
      line="$(text_of "$id")"
      [ -n "$line" ] && [[ "${reply[$((i + 1))]:-}" =~ ^WHY\ +(.+)$ ]] || return 1
      ids+=("$id")
      files+=("${id:0:1}")
      report+=("$(say "SIMILAR $id" "$line")" "$(say WHY "${BASH_REMATCH[1]}")")
      i=$((i + 2))
    done
    [ "${#ids[@]}" -gt 0 ] || return 1
  fi
  [[ "${reply[$i]:-}" =~ ^FORM\ +(.+)$ ]] || return 1
  form="${BASH_REMATCH[1]}"
  report+=("$(say FORM "$form")")
  i=$((i + 1))
  if [ "${#ids[@]}" -gt 0 ]; then
    local merged=()
    while [ "$i" -lt "${#reply[@]}" ] && [[ "${reply[$i]}" =~ ^MERGE\ +($ONE_ID)\ +(.+)$ ]]; do
      merged+=("${BASH_REMATCH[1]}")
      report+=("$(say "MERGE ${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}")")
      i=$((i + 1))
    done
    [ "$(printf '%s\n' "${merged[@]}" | sort | paste -sd ,)" = "$(printf '%s\n' "${ids[@]}" | sort | paste -sd ,)" ] || return 1
    if [ "$(printf '%s\n' "${files[@]}" | sort -u | wc -l)" -gt 1 ]; then
      [[ "${reply[$i]:-}" =~ ^SHARED\ +(.+)$ ]] || return 1
      report+=("$(say SHARED "${BASH_REMATCH[1]}")")
      i=$((i + 1))
    fi
  elif [ "${form,,}" != ok ]; then
    [[ "${reply[$i]:-}" =~ ^REWRITE\ +(.+)$ ]] || return 1
    report+=("$(say REWRITE "${BASH_REMATCH[1]}")")
    i=$((i + 1))
  fi
  [ "$i" -eq "${#reply[@]}" ]
}

if [ -z "$replace$distinct$remove" ]; then
  errors="$(mktemp)"
  trap 'rm -f "$errors"' EXIT
  answer="$(ask_agent 2>"$errors" 8>&-)" || check_failed "$answer
$(cat "$errors")"
  parse "$answer" || check_failed "$answer"
  printf '%s\n' "${report[@]}"
  if [ "${#ids[@]}" -gt 0 ]; then
    say NEXT "write nothing; re-run with --replace <id> \"<the widened sentence>\" or --distinct $(IFS=,; echo "${ids[*]}") \"<sentence>\""
    exit 2
  fi
fi

if [ -n "$remove" ]; then
  updated="$(mktemp)"
  grep -v "^- $remove: " "$target" >"$updated" || true
  cat "$updated" >"$target"
  rm -f "$updated"
  say "REMOVED $name $remove"
elif [ -n "$replace" ]; then
  id="$replace"
  updated="$(mktemp)"
  LESSON="- $id: $sentence" awk -v head="- $id: " 'index($0, head) == 1 { print ENVIRON["LESSON"]; next } { print }' "$target" >"$updated"
  cat "$updated" >"$target"
  rm -f "$updated"
  say "REPLACED $name $id"
else
  highest="$( { cat "$target"; git -C "$memory" log --format= -p -- "$path" || true; } | sed -nE "s/^[-+ ]?- $letter([0-9]+): .*/\1/p" | sort -n | tail -1)"
  id="$letter$(( ${highest:-0} + 1 ))"
  [ -z "$(tail -c1 "$target")" ] || printf '\n' >>"$target"
  printf -- '- %s: %s\n' "$id" "$sentence" >>"$target"
  say "WRITTEN $name $id"
  [ -z "$distinct" ] || say "DISTINCT $distinct"
fi

count="$(grep -cE "^- $letter[0-9]+: " "$target" || true)"
[ "$count" -le "$CAP" ] || say "OVER $name $count" "the consultant widens"

status=0
pushed="$(MEMORY_DIR="$memory" "$here/memory-push.sh" "$path")" || status=$?
while IFS= read -r line; do
  case "$line" in
    "pushed: "*) say "PUSHED ${line#pushed: }" ;;
    "push blocked: "*) say NEXT "$line: follow running.md § The memory push" ;;
    *) printf '%s\n' "$line" ;;
  esac
done <<<"$pushed"
exit "$status"
