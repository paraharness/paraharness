#!/usr/bin/env bash
set -euo pipefail
surface="${1:-}"
case "$surface" in
  app) script=e2e:journeys:local ;;
  admin) script=e2e:local ;;
  *) echo "journeys-local: usage: OUT=<dir> journeys-local.sh app|admin" >&2; exit 2 ;;
esac
out="${OUT:?journeys-local: OUT names the folder holding plan.json}"
root="$(git rev-parse --show-toplevel)"
journeys="apps/$surface/e2e/journeys"
result="$out/$surface-e2e.json"
results="$root/apps/$surface/test-results"
screenshots="$out/$surface-screenshots"
rm -rf -- "$screenshots"
mkdir -- "$screenshots"

unset CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET ADMIN_ACCESS_CLIENT_ID ADMIN_ACCESS_CLIENT_SECRET \
  ADMIN_DEV_ACCESS_CLIENT_ID ADMIN_DEV_ACCESS_CLIENT_SECRET WALK_SEED_KEY CLAUDE_CODE_OAUTH_TOKENS \
  CLOUDFLARE_API_TOKEN CLOUDFLARE_DEPLOY_TOKEN CLOUDFLARE_ACCOUNT_ID LINEAR_API_KEY RELEASE_APP_PRIVATE_KEY GITHUB_TOKEN GH_TOKEN

if [[ -z "$(find "$root/$journeys" -name '*.spec.ts' -print -quit 2>/dev/null)" ]]; then
  printf '{"ran":0,"findings":[],"infrastructure":[],"note":"no journeys yet"}\n' >"$result"
  echo "journeys-local: $surface has no journeys yet"
  exit 0
fi

chosen="$(node "$root/infra/verify/qa-plan.mjs" files --plan "$out/plan.json" --surface "$surface")"
mapfile -t selection <<<"$chosen"
files=("${selection[@]:1}")
grep_tag="$(node -p 'require(process.argv[1]).grep ?? ""' "$out/plan.json")"
[[ -z "$grep_tag" ]] || files+=(--grep "$grep_tag")
if [[ "${selection[0]}" == none ]]; then
  printf '{"ran":0,"findings":[],"infrastructure":[],"note":"no journeys selected"}\n' >"$result"
  echo "journeys-local: the plan selects no $surface journey"
  exit 0
fi

if [[ "$surface" == admin ]]; then
  E2E_PORT="$(node -e "const s = require('node:net').createServer().listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); });")"
  export E2E_PORT
fi

. "$root/infra/scripts/qa-browser-env.sh"
export LIVE_REPORT="$out/$surface-report.json"
rm -f "$LIVE_REPORT"
rm -rf -- "$results"
echo "journeys-local: $surface: ${selection[0]}${files[*]:+: ${files[*]}}"
${JOURNEYS_PNPM:-pnpm} --dir "$root/apps/$surface" run "$script" "${files[@]}" && code=0 || code=$?
if [[ -d "$results" ]]; then
  (cd "$results" && find . -mindepth 1 -name '.*' -prune -o -type f -name 'test-failed-*.png' -exec cp --parents --no-dereference -t "$screenshots" -- {} +)
fi
if ! node "$root/infra/scripts/qa-e2e.mjs" --surface "$surface" --report "$LIVE_REPORT" --out "$result"; then
  printf '{"ran":0,"findings":[],"infrastructure":["the journeys did not report (exit %s)"]}\n' "$code" >"$result"
fi
exit "$code"
