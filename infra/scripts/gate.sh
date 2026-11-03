#!/usr/bin/env bash
set -euo pipefail
shopt -s inherit_errexit
plan=false
all=false
lint_only=false
no_bail=false
base_ref=origin/main
stdin_files=false
stdin_list=()
while [ $# -gt 0 ]; do
  case "$1" in
    --plan) plan=true ;;
    --full) all=true ;;
    --lint-only) lint_only=true ;;
    --no-bail) no_bail=true ;;
    --base)
      base_ref="$2"
      shift
      ;;
    --stdin)
      stdin_files=true
      mapfile -t stdin_list
      ;;
    *)
      echo "usage: gate.sh [--plan] [--full | --lint-only] [--no-bail] [--base <ref>] [--stdin]" >&2
      exit 2
      ;;
  esac
  shift
done
cd "$(git rev-parse --show-toplevel)"

package_of() {
  local rest="${1#*/}"
  case "$1" in
    apps/*/* | packages/*/*) printf -v "$2" '%s/%s' "${1%%/*}" "${rest%%/*}" ;;
    *) printf -v "$2" '%s' "${1%%/*}" ;;
  esac
}

module_of() {
  local path="${1%%\?*}"
  [[ ${path##*/} == *.* ]] && path="${path%.*}"
  printf -v "$2" '%s' "${path%/index}"
}

declare -A importers=()
index_path_imports() {
  local refs line file spec resolved from to module i
  local -a sources=() joined=() targets=()
  refs="$(git grep -o -E "(\.\.?/)+[^'\"[:space:]\`),;]+" -- 'apps/*/*' 'packages/*/*' 'infra/*')" || [ $? -eq 1 ]
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    file="${line%%:*}"
    spec="${line#*:}"
    sources+=("$file")
    joined+=("${file%/*}/${spec%%\?*}")
  done <<<"$refs"
  [ "${#joined[@]}" -gt 0 ] || return 0
  resolved="$(printf '%s\n' "${joined[@]}" | xargs -d '\n' realpath -m --relative-to=.)"
  mapfile -t targets <<<"$resolved"
  for i in "${!targets[@]}"; do
    case "${targets[i]}" in apps/*/* | packages/*/* | infra/*) ;; *) continue ;; esac
    package_of "${sources[i]}" from
    package_of "${targets[i]}" to
    [ "$from" != "$to" ] || [ "$to" = infra ] || continue
    module_of "${targets[i]}" module
    importers[$module]+="${sources[i]}"$'\n'
  done
}

serves_by_path() {
  case "$1" in
    infra/scripts/edge-deploy.sh | infra/scripts/gate-passed.sh) bundle=true ;;
    infra/verify/*) dirs+=(apps/app apps/edge) ;;
  esac
}

manifest_deps_same() {
  node -e '
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const [base, file] = process.argv.slice(1);
const deps = (text) => {
  const manifest = JSON.parse(text);
  return JSON.stringify(["dependencies", "peerDependencies"].map((key) => Object.entries(manifest[key] ?? {}).sort()));
};
let before = "{}";
try {
  before = execFileSync("git", ["show", `${base}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch {}
const after = existsSync(file) ? readFileSync(file, "utf8") : "{}";
process.exit(deps(before) === deps(after) ? 0 : 1);
' "$base" "$1" 2>/dev/null
}

lockfile_reach() {
  node -e '
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { join } = require("node:path");
let YAML;
try {
  YAML = createRequire(join(process.cwd(), "infra/package.json"))("yaml");
} catch {
  YAML = require("yaml");
}
const [base] = process.argv.slice(1);
const before = YAML.parse(execFileSync("git", ["show", `${base}:pnpm-lock.yaml`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 }));
const after = YAML.parse(readFileSync("pnpm-lock.yaml", "utf8"));
const TREE = ["importers", "packages", "snapshots"];
const settings = (lock) => JSON.stringify(Object.entries(lock).filter(([key]) => !TREE.includes(key)).sort(([a], [b]) => (a < b ? -1 : 1)));
if (settings(before) !== settings(after)) {
  console.log("GLOBAL");
  process.exit(0);
}
const DIRECT = ["dependencies", "devDependencies", "optionalDependencies"];
const tree = (lock, importer) => {
  const entry = lock.importers?.[importer] ?? null;
  const seen = new Set();
  const queue = DIRECT.flatMap((kind) => Object.entries(entry?.[kind] ?? {}).map(([name, spec]) => [name, String(spec.version)]));
  while (queue.length > 0) {
    const [name, version] = queue.pop();
    const key = `${name}@${version}`;
    if (version.startsWith("link:") || seen.has(key)) continue;
    seen.add(key);
    const snapshot = lock.snapshots?.[key] ?? {};
    for (const kind of ["dependencies", "optionalDependencies"]) queue.push(...Object.entries(snapshot[kind] ?? {}).map(([dep, ver]) => [dep, String(ver)]));
  }
  const nodes = [...seen].sort().map((key) => [key, lock.snapshots?.[key] ?? null, lock.packages?.[key.replace(/\(.*$/, "")] ?? null]);
  return JSON.stringify([entry, nodes]);
};
const importers = [...new Set([...Object.keys(before.importers ?? {}), ...Object.keys(after.importers ?? {})])].sort();
for (const importer of importers) {
  if (tree(before, importer) === tree(after, importer)) continue;
  if (importer === ".") console.log("GLOBAL");
  else if (after.importers?.[importer] && existsSync(join(importer, "package.json"))) console.log(importer);
}
' "$base" 2>/dev/null
}

global=false
code=false
lockfile=false
skipped=0
bundle=false
lint_all=false
dirs=()
touched=()
files=()
if $all; then
  global=true
elif ! $lint_only; then
  git fetch -q origin main 2>/dev/null || true
  base="$(git merge-base "$base_ref" HEAD)"
  if $stdin_files; then
    files=("${stdin_list[@]}")
  else
    mapfile -t files < <({ git diff --name-only --no-renames "$base"; git ls-files --others --exclude-standard; } | sort -u)
  fi
  scoped=()
  for f in "${files[@]}"; do
    case "$f" in
      package.json | */package.json)
        if manifest_deps_same "$f"; then
          skipped=$((skipped + 1))
          continue
        fi
        global=true
        ;;
      pnpm-lock.yaml)
        lockfile=true
        skipped=$((skipped + 1))
        continue
        ;;
      pnpm-workspace.yaml | tsconfig.base.json | .npmrc) global=true ;;
      apps/*/* | packages/*/*)
        code=true
        package_of "$f" d
        dirs+=("$d")
        touched+=("$d")
        ;;
      infra/* | .github/*)
        code=true
        dirs+=(infra)
        touched+=(infra)
        [ "$f" != infra/scripts/strip-comments.mjs ] || lint_all=true
        serves_by_path "$f"
        ;;
      .oxlintrc.json | .mergify.yml)
        code=true
        dirs+=(infra)
        touched+=(infra)
        [ "$f" != .oxlintrc.json ] || lint_all=true
        ;;
      *.md | .claude/* | CLAUDE.md | .gitignore) ;;
      *) global=true ;;
    esac
    scoped+=("$f")
  done
  files=("${scoped[@]}")
  if $lockfile && ! $global; then
    if reach="$(lockfile_reach)" && ! grep -qx GLOBAL <<<"$reach"; then
      while IFS= read -r d; do
        [ -n "$d" ] || continue
        code=true
        dirs+=("$d")
      done <<<"$reach"
    else
      global=true
    fi
  fi
  if $code && ! $global; then
    index_path_imports
    declare -A listed=()
    for f in "${files[@]}"; do listed[$f]=1; done
    for ((i = 0; i < ${#files[@]}; i++)); do
      module_of "${files[i]}" module
      [ -n "$module" ] || continue
      while IFS= read -r f; do
        [ -n "$f" ] && [ -z "${listed[$f]:-}" ] || continue
        listed[$f]=1
        package_of "$f" d
        dirs+=("$d")
        case "$f" in apps/*/* | packages/*/* | infra/*) files+=("$f") ;; esac
      done <<<"${importers[$module]:-}"
    done
  fi
fi
filters=()
if $code; then
  mapfile -t dirs < <(printf '%s\n' "${dirs[@]}" | sort -u)
  for d in "${dirs[@]}"; do filters+=(--filter "...{./$d}"); done
fi

reached=()
build_filters=()
lint_paths=(.)
if $code && ! $global; then
  parseable="$(pnpm ls -r --depth -1 --parseable "${filters[@]}")"
  mapfile -t reached < <(sed -n "s|^$(pwd -P)/||p" <<<"$parseable" | sort)
  for r in "${reached[@]}"; do build_filters+=(--filter "{./$r}^..."); done
  if $bundle; then build_filters+=(--filter "{./apps/edge}^..."); fi
  if ! $lint_all; then
    lint_paths=()
    for d in $(printf '%s\n' "${touched[@]}" | sort -u); do
      if [ -d "$d" ]; then lint_paths+=("$d"); fi
    done
  fi
fi

if $plan; then
  touched_line="touched=$(printf '%s\n' "${touched[@]}" | sort -u | paste -sd ' ')"
  if $global; then
    printf 'lane=full\nweb=true\nedge=true\n%s\n' "$touched_line"
  elif $code; then
    printf 'lane=code\n'
    [[ " ${reached[*]} " == *" apps/app "* ]] && echo web=true || echo web=false
    { $bundle || [[ " ${reached[*]} " == *" apps/edge "* ]]; } && echo edge=true || echo edge=false
    printf 'reach=%s\n' "${reached[*]}"
    printf '%s\n' "$touched_line"
    printf 'lint=%s\n' "${lint_paths[*]}"
    built=()
    while IFS= read -r d; do
      if grep -q '"build":' "$d/package.json"; then built+=("${d#"$(pwd -P)/"}"); fi
    done < <(pnpm ls -r --depth -1 --parseable "${build_filters[@]}" | grep "^$(pwd -P)/" | sort)
    printf 'build=%s\n' "${built[*]}"
  elif ! $lint_only && [ "${#files[@]}" -eq 0 ] && [ "$skipped" -eq 0 ]; then
    printf 'lane=none\nweb=false\nedge=false\nreach=\n'
  else
    printf 'lane=lint\nweb=false\nedge=false\nreach=\n'
  fi
  exit 0
fi

if ! $global && ! $code && ! $lint_only && [ "${#files[@]}" -eq 0 ] && [ "$skipped" -eq 0 ]; then
  echo "gate: GREEN (nothing changed against $base_ref)"
  exit 0
fi

summary=pnpm-exec-summary.json
each=()
failed=()
results=()
if $no_bail; then
  each=(--no-bail --report-summary)
  trap 'rm -f "$summary"' EXIT
fi

step() {
  local name="$1"
  shift
  echo "gate: $name"
  if ! $no_bail; then
    "$@"
    return
  fi
  rm -f "$summary"
  "$@" || failed+=("$name")
  if [ -f "$summary" ]; then
    mapfile -t -O "${#results[@]}" results < <(node -e '
      const { relative } = require("node:path");
      const { executionStatus } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      for (const [dir, { status }] of Object.entries(executionStatus)) console.log(`gate: ${process.argv[2]} ${relative(process.cwd(), dir) || "."} ${status}`);
    ' "$summary" "$name")
    rm -f "$summary"
  fi
}

test_concurrency=()
if [ -n "${TEST_MAX_WORKERS:-}" ]; then
  if ! [[ $TEST_MAX_WORKERS =~ ^[1-9][0-9]*$ ]]; then
    echo "gate: TEST_MAX_WORKERS must be a whole number of at least 1, not '$TEST_MAX_WORKERS'" >&2
    exit 2
  fi
  export VITEST_MAX_WORKERS="$TEST_MAX_WORKERS"
  test_concurrency=(--workspace-concurrency=1)
fi
if [ -n "${TEST_PACKAGES_AT_ONCE:-}" ]; then
  if ! [[ $TEST_PACKAGES_AT_ONCE =~ ^[1-9][0-9]*$ ]]; then
    echo "gate: TEST_PACKAGES_AT_ONCE must be a whole number of at least 1, not '$TEST_PACKAGES_AT_ONCE'" >&2
    exit 2
  fi
  test_concurrency=(--workspace-concurrency="$TEST_PACKAGES_AT_ONCE" --no-sort --aggregate-output --reporter-hide-prefix)
fi

lint_touched() {
  pnpm exec oxlint "${lint_paths[@]}" && node infra/scripts/strip-comments.mjs --check --type ts,tsx "${lint_paths[@]}"
}

if [ "${lint_paths[*]}" = . ]; then
  step lint pnpm run lint
elif [ "${#lint_paths[@]}" -gt 0 ]; then
  step lint lint_touched
fi

if $global; then
  step build pnpm -r --if-present "${each[@]}" run build
  step typecheck pnpm -r --if-present "${each[@]}" run typecheck
  step i18n pnpm run i18n:check
  step test pnpm -r --if-present "${each[@]}" "${test_concurrency[@]}" run test
  step balance pnpm --filter @wg/game-wordgrid run test:balance
elif $code; then
  step build pnpm -r --if-present "${each[@]}" "${build_filters[@]}" run build
  step typecheck pnpm -r --if-present "${each[@]}" "${filters[@]}" run typecheck
  if [ "${#reached[@]}" -gt 0 ]; then
    step test node infra/scripts/check-touched.mjs --gate "$base" "${reached[@]}"
  else
    step test pnpm -r --if-present "${each[@]}" "${test_concurrency[@]}" run test
  fi
  dir_list="$(printf '%s\n' "${dirs[@]}")"
  grep -q '^packages/i18n$\|^apps/' <<<"$dir_list" && step i18n pnpm run i18n:check
  grep -q '^apps/app$\|^apps/admin$' <<<"$dir_list" && step journeys pnpm --filter @wg/infra run test verify/__tests__/journeys-map.test.mjs
  grep -q '^packages/game-wordgrid$\|^packages/languages$' <<<"$dir_list" && step balance pnpm --filter @wg/game-wordgrid run test:balance
fi

if [ "${#results[@]}" -gt 0 ]; then printf '%s\n' "${results[@]}"; fi
if [ "${#failed[@]}" -gt 0 ]; then
  echo "gate: RED (failed: ${failed[*]})"
  exit 1
fi
echo "gate: GREEN"
