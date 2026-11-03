#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: memory-push.sh <paths…>" >&2
  exit 2
fi

paths="$*"
named=("$@")
stage=start
settling=

block() {
  stage=done
  printf 'push blocked: %s\n' "$1"
  exit 1
}

g() {
  git -c core.quotePath=false "$@" 9>&-
}

first_line() {
  awk 'NF { print; exit }' <<<"$1"
}

session="${MEMORY_SESSION:-${CLAUDE_CODE_SESSION_ID:-}}"
[ -n "$session" ] || block "no session id $paths"
trailer="Memory-Session: $session"
folder="${CLAUDE_HARNESS_DIR:-${TMPDIR:-/tmp}/claude-harness}/$session/memory-push"

source "$(dirname "${BASH_SOURCE[0]}")/memory-dir.sh"
memory_dir="$(memory_checkout)" || block "no memory checkout $PWD"
[ -d "$memory_dir" ] || block "no memory checkout $memory_dir"
git_dir="$(g -C "$memory_dir" rev-parse --path-format=absolute --git-dir 2>/dev/null)" || block "no memory checkout $memory_dir"
cd "$memory_dir"

lock="$git_dir/memory-push.lock"
exec 9>"$lock"
flock -n 9 || block "lock held $paths ($lock)"

if [ -e "$git_dir/MERGE_HEAD" ]; then
  output="$(g merge --abort 2>&1)" || block "merge failed $paths (merge --abort: $(first_line "$output"))"
fi

branch="$(g rev-parse --abbrev-ref HEAD)"
remote="origin/$branch"

tracked() {
  grep -qxF -- "$1" <<<"$(g ls-files -- ":(literal)$1")"
}

in_head() {
  g cat-file -e "HEAD:$1" 2>/dev/null
}

addable=()
for path in "$@"; do
  if [ -L "$path" ] || [ -f "$path" ] || { [ ! -e "$path" ] && tracked "$path"; }; then
    addable+=("$path")
  elif [ ! -e "$path" ] && in_head "$path"; then
    continue
  else
    block "not a file $paths ($path)"
  fi
done

own() {
  grep -qxF -- "$session" <<<"$(g log -1 --format='%(trailers:key=Memory-Session,valueonly)' "$1")"
}

own_unpushed() {
  grep -cxF -- "$session" <<<"$(g log --format='%(trailers:key=Memory-Session,valueonly)' "$remote..HEAD")" || true
}

ancestor_of_remote() {
  g merge-base --is-ancestor "${1:-HEAD}" "$remote"
}

own_chain() {
  local commit
  commit="$(g rev-parse HEAD)"
  while own "$commit" && ! ancestor_of_remote "$commit"; do
    echo "$commit"
    commit="$(g rev-parse "$commit~1")"
  done
}

declare -A copied=()
run_folder="$folder/$(date -u +%Y%m%dT%H%M%S.%NZ)"

save_copy() {
  [ -z "${copied[$2]:-}" ] || return 0
  copied[$2]=yes
  g cat-file -e "$1:$2" 2>/dev/null || return 0
  mkdir -p "$(dirname "$run_folder/$2")" 2>/dev/null || return 1
  { g show "$1:$2" >"$run_folder/$2"; } 2>/dev/null || return 1
}

save_copies() {
  local path commit
  local -a changed
  mkdir -p "$run_folder" 2>/dev/null || return 1
  for path in "${named[@]}"; do
    save_copy HEAD "$path" || return 1
  done
  for commit in $(own_chain); do
    if g rev-parse -q --verify "$commit^2" >/dev/null; then
      continue
    fi
    mapfile -t changed < <(g diff --name-only --no-renames "$commit~1" "$commit")
    for path in "${changed[@]}"; do
      save_copy "$commit" "$path" || return 1
    done
  done
}

incomplete=

put_back() {
  "${@:2}" || { incomplete="${incomplete:-$1}"; return 1; }
}

drop_own_commits() {
  local -a changed
  while own HEAD && ! ancestor_of_remote; do
    mapfile -t changed < <(g diff --name-only --no-renames HEAD~1 HEAD)
    put_back reset g reset -q --soft HEAD~1 || return 1
    [ "${#changed[@]}" -eq 0 ] || put_back restore g restore -q --staged --worktree --source=HEAD -- "${changed[@]}" || return 1
  done
}

fail() {
  local note= version
  [ -z "$settling" ] || return 0
  settling=yes
  trap '' INT TERM
  if [ -e "$git_dir/MERGE_HEAD" ]; then
    put_back "merge --abort" g merge --abort || true
  fi
  save_copies || block "no save folder $paths ($folder)"
  version=" (your version: $run_folder)"
  drop_own_commits || true
  if own HEAD && ! ancestor_of_remote; then
    block "$1 (put-back incomplete: $incomplete; your commit $(g rev-parse --short HEAD) is on top)$version"
  elif ancestor_of_remote; then
    if ! g merge -q --ff-only "$remote" >/dev/null 2>&1 && [ -z "$incomplete" ]; then
      note=" (HEAD stays behind the remote: another session's change)"
    fi
  elif [ "${2:-}" = foreign ]; then
    note=" ($(g rev-parse --short HEAD) is unpushed)"
  else
    note=" (another session's commit $(g rev-parse --short HEAD) is unpushed)"
  fi
  [ -z "$incomplete" ] || note="$note (put-back incomplete: $incomplete)"
  block "$1$note$version"
}

merge_failed() {
  local note=
  if [ -e "$git_dir/MERGE_HEAD" ]; then
    g merge --abort >/dev/null 2>&1 || note=" (put-back incomplete: merge --abort)"
  fi
  block "merge failed $paths ($(first_line "$1"))$note"
}

overwritten() {
  awk '/would be overwritten/ { on = 1; next } on && /^[[:space:]]/ { sub(/^[[:space:]]+/, ""); print; next } { on = 0 }' <<<"$1" | paste -sd ' '
}

sync_origin() {
  local output conflicts
  output="$(g fetch -q origin 2>&1)" || block "pull failed $paths ($(first_line "$output"))"
  g merge-base --is-ancestor "$remote" HEAD && return 0
  if output="$(g merge --no-commit --no-ff "$remote" 2>&1)"; then
    output="$(g commit -q --no-edit --trailer "$trailer" 2>&1)" && return 0
    merge_failed "$output"
  fi
  if [ -e "$git_dir/MERGE_HEAD" ]; then
    conflicts="$(g diff --name-only --diff-filter=U | sort -u | paste -sd ' ')"
    fail "merge conflict $paths ($conflicts)"
  fi
  [[ "$output" != *"would be overwritten"* ]] || fail "dirty tree $paths ($(overwritten "$output"))"
  merge_failed "$output"
}

interrupted() {
  case "$stage" in
    sync) ;;
    commit) [ "$(g rev-parse HEAD)" != "$before" ] || return 0 ;;
    *) return 0 ;;
  esac
  if [ ! -e "$git_dir/MERGE_HEAD" ] && ancestor_of_remote; then
    return 0
  fi
  fail "interrupted $paths"
}

trap interrupted EXIT
trap 'interrupted; exit 130' INT
trap 'interrupted; exit 143' TERM

for path in "${addable[@]}"; do
  output="$(g add -- "$path" 2>&1)" || block "add failed $paths ($path: $(first_line "$output"))"
done
if g diff --cached --quiet -- "$@" && [ "$(own_unpushed)" = 0 ]; then
  block "nothing staged $paths"
fi

before="$(g rev-parse HEAD)"
stage=commit
if ! g diff --cached --quiet -- "$@"; then
  output="$(g commit -q -m "memory: $paths" --trailer "$trailer" -- "$@" 2>&1)" || block "commit failed $paths ($(first_line "$output"))"
fi
stage=sync

foreign_unpushed() {
  local commit
  for commit in $(g rev-list "$remote..HEAD"); do
    own "$commit" || return 0
  done
  return 1
}

push_own() {
  if foreign_unpushed; then
    fail "another session's commit $paths" foreign
  fi
  g push -q origin "HEAD:$branch"
}

sync_origin
if ! push_own; then
  sync_origin
  push_own || block "push rejected twice $paths"
fi
stage=done
rm -rf "${folder:?}" 2>/dev/null || true

echo "pushed: $paths"

