#!/usr/bin/env bash
# The Workers deploy (ARCHITECTURE §20.4): what Workers Builds runs from the stack's api deploy
# branch, root `/`, previews off — `deploy/api` for production (Worker cd-api, `--env production`),
# `deploy/api-dev` for dev (Worker cd-api-dev, `--env dev`; CD-285).
# In order, and stopping at the first failure:
#
#   1. build the workspace packages the Workers bundle (`@wg/edge^...`);
#   2. apply the D1 migrations to EVERY database the environment's config lists — the same list
#      `ShardMap` and the `db` module know (`src/db/databases.ts`, kept equal by a test);
#   3. `wrangler deploy` the `auth` Worker, then the `admin` Worker, then the `api` Worker, each with
#      `BUILD_SHA`. The service binding points from `api` to `auth`, so `auth` is never older than its
#      caller. The admin (§24) goes BEFORE api because api's `/api/v1/health` is the one thing every
#      release waits on: api reporting the new build then proves the admin deployed too,
#      and a failed admin deploy stops here with api still on the old build, so the release fails and
#      rolls back (CD-291 review). Except on the first deploy of a Durable Object class the admin binds
#      (code 10061, below): api deploys first, then the admin again, so a failed second admin deploy
#      leaves api's /health on the new build and fails only the Workers Build. /health alone then does
#      not prove the admin deployed. The admin binds api's SpendGuard and Wallet by
#      script name, so a method the admin starts calling must exist in api one release earlier, as
#      with auth's RPC.
#      The admin's React app (apps/admin) is built in step 1 and its database `cd-admin` is migrated
#      in step 2; the admin rides the api half: dev first, then production, and its rollback.
#
#   infra/scripts/edge-deploy.sh --env production|dev [--sha <sha>] [--dry-run [--gate]] [--accept-var-change] [--force]
#
# THE GATE (CLAUDE.md, CD-160, CD-280), by hand: a deploy is refused unless GitHub shows the `checks` and
# `gate` statuses passing on the checkout's tree (`wb_gate_passed` in `gate-passed.sh`, the gate's
# statuses are the only evidence, the `verified/<sha>` marks are retired), the
# checkout's tree IS that commit's tree (a promotion merge carries it), nothing tracked is uncommitted,
# and no untracked file sits in apps/edge (exit 4: `wrangler d1 migrations apply` takes every .sql there):
# this script deploys the checkout, not an archive of the commit, so what ships must be what passed. A
# GitHub it cannot ask is a refusal too. --dry-run needs no gate (the gate bundles first), and --gate
# makes a dry run check it anyway; --force skips only the gate, loudly.
#
# IN WORKERS BUILDS (WORKERS_CI=1, CD-177): `cd-api` is connected to `deploy/api` and `cd-api-dev` to
# `deploy/api-dev`, root `/`, and each one's deploy command is this script
# (`bash infra/scripts/edge-deploy.sh --env production`, `... --env dev`), so a push to the branch
# is the deploy. THE GATE IS NOT
# RE-CHECKED THERE (owner, 5 Oct, CD-215): only the release workflow moves the deploy branches (a ruleset), and
# it promotes a tree only after `checks` and `gate` passed it, so the build deploys the checkout it was
# given and asks GitHub nothing (the 5 Oct release found the re-check could not even run there: no
# token, no deploy, a rollback). What still holds, and needs no token: the tip must be a promotion
# merge — its second parent is BUILD_SHA, and its tree is that commit's tree (the commit is fetched
# from origin by sha, depth 1, for the comparison), the shape only a promotion merge has, so a plain push
# deploys nothing and `/health` names what runs — and nothing tracked uncommitted, nothing untracked
# in apps/edge. On top of it:
#   - the clone must be at WORKERS_CI_COMMIT_SHA on the environment's branch (WORKERS_CI_BRANCH), or
#     it refuses: a production build of `deploy/api-dev`, or a dev build of `deploy/api`, deploys nothing;
#   - the clone is shallow, so the tip's parents are read from its commit object (BUILD_SHA below), and
#     the stamped commit is fetched from origin for the tree comparison. The connected clone reaches
#     origin by itself (the 5 Oct build's `ls-remote` answered), and that access is tried first;
#     EDGE_DEPLOY_GIT_TOKEN (a read-only GitHub token, build secret) is sent only when origin refuses
#     it, so an expired token costs nothing while the clone's own access works. EDGE_DEPLOY_ORIGIN
#     names origin if the clone has none;
#   - Node must satisfy the root `engines`, and pnpm must be the root `packageManager`'s version, else
#     `corepack pnpm@<that>`; it installs `@wg/edge...` itself (SKIP_DEPENDENCY_INSTALL=1);
#   - its Cloudflare token is the build secret EDGE_DEPLOY_API_TOKEN, exported as CLOUDFLARE_API_TOKEN
#     only after the install and build (the build's own token cannot migrate D1);
#   - Workers Builds sets WRANGLER_CI_OVERRIDE_NAME, which wrangler applies to EVERY deploy: left
#     alone, `auth` would be uploaded as the api Worker's name. It must name this environment's api Worker, and
#     it is removed; WRANGLER_CI_MATCH_TAG is kept for the api deploy alone;
#   - --force and --accept-var-change are refused: they are a person's call at a terminal.
#
# Before anything remote moves, the environment's plain vars in the configs are compared with what
# its Workers run live (`scripts/live-vars.mjs`, CLOUDFLARE_API_TOKEN): a deploy that would change
# one is refused (CD-142: a wrong-valued deploy would silently repoint a live stack). A change meant
# on purpose passes --accept-var-change. A Worker that does not exist yet has nothing to compare.
#
# BUILD_SHA is the VERIFIED commit, not the branch tip: a promotion moves `deploy/api` by a merge
# commit whose second parent is the verified sha and whose tree is its tree, so the tip's second
# parent is what `/health` must report. `--sha` (or BUILD_SHA in the environment) overrides it.
# Workers Builds hands the tip in WORKERS_CI_COMMIT_SHA; the parents come from the tip's commit
# object, which a shallow clone keeps, and a tip with no second parent is reported as is.
#
# DEV WAITS FOR PRODUCTION'S TRANSFER (CD-285): dev's migrations v2/v3 delete its 11 Durable Object
# classes and create them again empty, which is safe only once production's v1 has moved them, with
# their objects, from cd-api-dev. So a real `--env dev` deploy first asks Cloudflare which migration
# the production api Worker is at (`scripts/transfer-guard.mjs`, the Workers scripts list) and is
# refused unless it is at production's transfer tag or a later one (CD-291 added v2). TRANSFER_GUARD
# replaces it in tests.
#
# --dry-run bundles both Workers (`wrangler deploy --dry-run`) and touches nothing remote: no
# migration, no upload. `pnpm verify` runs it on every full gate, so the bundle that would ship
# builds before the gate passes anything (cold review M6).
#
# Nothing here asks for confirmation and nothing is run against production from a sandbox: the
# owner's promotion path decides when this runs (CLAUDE.md). WRANGLER replaces `npx wrangler`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/gate-passed.sh
. "$SCRIPT_DIR/gate-passed.sh"

EDGE_DIR="${EDGE_DIR:-$(cd "$SCRIPT_DIR/../../apps/edge" && pwd)}"
REPO_ROOT="${EDGE_REPO_ROOT:-$(cd "$EDGE_DIR/../.." && pwd)}"
WRANGLER="${WRANGLER:-npx wrangler}"
PNPM="${PNPM:-pnpm}"
# WB_NODE, never NODE: pnpm and npm export NODE as their OWN executable to every script they run,
# and a standalone pnpm (the wb runners' @pnpm/exe) is not a node (CD-196).
NODE="${WB_NODE:-node}"
COREPACK="${COREPACK:-corepack}"
DEPLOY_BRANCH="${EDGE_DEPLOY_BRANCH:-}"
ENV_NAME=''
SHA="${BUILD_SHA:-}"
DRY_RUN=0
GATE_DRY_RUN=0
ACCEPT_VAR_CHANGE=0
FORCE=0
IN_CI=0
[[ "${WORKERS_CI:-}" == 1 ]] && IN_CI=1
LIVE_VARS="${LIVE_VARS:-$NODE scripts/live-vars.mjs}"
TRANSFER_GUARD="${TRANSFER_GUARD:-$NODE scripts/transfer-guard.mjs}"

die() { echo "edge-deploy: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env) [[ $# -ge 2 ]] || die "--env needs production or dev"; ENV_NAME="$2"; shift 2 ;;
    --env=*) ENV_NAME="${1#--env=}"; shift ;;
    --sha) [[ $# -ge 2 ]] || die "--sha needs a commit"; SHA="$2"; shift 2 ;;
    --sha=*) SHA="${1#--sha=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --gate) GATE_DRY_RUN=1; shift ;;
    --accept-var-change) ACCEPT_VAR_CHANGE=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$SCRIPT_DIR/edge-deploy.sh"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$ENV_NAME" in
  production) DEPLOY_BRANCH="${DEPLOY_BRANCH:-deploy/api}" ;;
  dev) DEPLOY_BRANCH="${DEPLOY_BRANCH:-deploy/api-dev}" ;;
  '') die "--env production|dev is required; the top level of the configs is the LOCAL definition" ;;
  *) die "no environment \"$ENV_NAME\" (production or dev)" ;;
esac

# The parents are read from the commit object itself, which a shallow clone keeps even though it
# grafts them away (`<tip>^2` does not resolve there).
second_parent() {
  git -C "$EDGE_DIR" cat-file -p "$1" 2>/dev/null | awk '/^parent / { n++; if (n == 2) { print $2; exit } } /^$/ { exit }'
}

verified_sha() {
  local tip="${WORKERS_CI_COMMIT_SHA:-}"
  if git -C "$EDGE_DIR" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    [[ -n "$tip" ]] || tip="$(git -C "$EDGE_DIR" rev-parse HEAD)"
    local second
    second="$(second_parent "$tip")"
    if [[ -n "$second" ]]; then echo "$second"; return; fi
  fi
  echo "$tip"
}

jsonc_field() { # jsonc_field <file> <env> <field>: that environment's field of a wrangler config
  $NODE -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync(process.argv[1], 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n'));
process.stdout.write(String(c.env?.[process.argv[2]]?.[process.argv[3]] ?? ''));" "$1" "$2" "$3"
}

ci_toolchain() {
  local want min have major
  want="$($NODE -e "process.stdout.write(String(require(process.argv[1]).packageManager ?? '').replace(/^pnpm@/, '').replace(/\+.*$/, ''))" "$REPO_ROOT/package.json")"
  min="$($NODE -e "process.stdout.write((/(\d+)/.exec(require(process.argv[1]).engines?.node ?? '') ?? ['', '0'])[1])" "$REPO_ROOT/package.json")"
  major="$($NODE -e 'process.stdout.write(process.versions.node.split(".")[0])')"
  [[ "$major" -ge "$min" ]] || die "Node $($NODE --version) here, and the repository needs Node $min or newer (root engines). Set the build variable NODE_VERSION=$min"
  [[ "$want" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "the root package.json names no pnpm version in packageManager"
  have="$($PNPM --version 2>/dev/null || true)"
  if [[ "$have" != "$want" ]]; then
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    have="$($COREPACK "pnpm@$want" --version 2>/dev/null || true)"
    [[ "$have" == "$want" ]] || die "pnpm $($PNPM --version 2>/dev/null || echo none) here, the repository pins pnpm $want (packageManager), and corepack could not provide it. Set the build variable PNPM_VERSION=$want"
    PNPM="$COREPACK pnpm@$want"
  fi
  echo "edge-deploy: Node $($NODE --version), pnpm $want ($PNPM)"
}

ci_checkout() {
  local tip="${WORKERS_CI_COMMIT_SHA:-}" head shallow
  [[ "$tip" =~ ^[0-9a-f]{40}$ ]] || die "Workers Builds named no commit (WORKERS_CI_COMMIT_SHA=\"$tip\"); nothing was deployed"
  [[ "${WORKERS_CI_BRANCH:-}" == "$DEPLOY_BRANCH" ]] || die "Workers Builds is building \"${WORKERS_CI_BRANCH:-}\"; only $DEPLOY_BRANCH deploys (its production branch; non-production builds stay off). Nothing was deployed"
  head="$(git -C "$EDGE_DIR" rev-parse --verify --quiet HEAD || true)"
  [[ "$head" == "$tip" ]] || die "the clone is at ${head:-nothing}, but Workers Builds is building $tip; nothing was deployed"
  shallow="$(git -C "$EDGE_DIR" rev-parse --is-shallow-repository 2>/dev/null || echo unknown)"
  echo "edge-deploy: Workers Builds ${WORKERS_CI_BUILD_UUID:-(no build id)}, $DEPLOY_BRANCH at ${tip:0:7}, shallow clone: $shallow"
  if ! git -C "$EDGE_DIR" remote get-url origin >/dev/null 2>&1; then
    [[ -n "${EDGE_DEPLOY_ORIGIN:-}" ]] || die "the clone has no origin remote, so the stamped commit cannot be fetched for the tree comparison. Set the build variable EDGE_DEPLOY_ORIGIN to the repository's https URL"
    git -C "$EDGE_DIR" remote add origin "$EDGE_DEPLOY_ORIGIN"
    echo "edge-deploy: origin added from EDGE_DEPLOY_ORIGIN"
  fi
  [[ -z "${EDGE_DEPLOY_GIT_TOKEN:-}" ]] || echo "edge-deploy: EDGE_DEPLOY_GIT_TOKEN is set; it is used only if origin refuses the clone's own access"
}

ci_fetch() {
  local spec="+$1:refs/edge-deploy/$1" refused
  if refused="$(git fetch --quiet --depth=1 origin "$spec" 2>&1)"; then return 0; fi
  echo "$refused" >&2
  [[ -n "${EDGE_DEPLOY_GIT_TOKEN:-}" ]] || return 1
  echo "edge-deploy: the fetch with the clone's own access failed (above); asking again with EDGE_DEPLOY_GIT_TOKEN"
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0='http.https://github.com/.extraheader' GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$EDGE_DEPLOY_GIT_TOKEN" | base64 | tr -d '\n')" git fetch --quiet --depth=1 origin "$spec"
}

ci_worker_names() {
  local api_name
  api_name="$(jsonc_field "$EDGE_DIR/wrangler.api.jsonc" "$ENV_NAME" name)"
  [[ -n "$api_name" ]] || die "wrangler.api.jsonc has no name for env \"$ENV_NAME\""
  if [[ -n "${WRANGLER_CI_OVERRIDE_NAME:-}" && "$WRANGLER_CI_OVERRIDE_NAME" != "$api_name" ]]; then
    die "Workers Builds is connected to \"$WRANGLER_CI_OVERRIDE_NAME\", but this environment's api Worker is \"$api_name\". Connect $api_name only (never the auth Worker); nothing was deployed"
  fi
  echo "edge-deploy: connected Worker ${WRANGLER_CI_OVERRIDE_NAME:-(not named)}; auth and api each deploy under their own config's name"
}

CI_MATCH_TAG="${WRANGLER_CI_MATCH_TAG:-}"
if [[ $IN_CI -eq 1 ]]; then
  [[ $FORCE -eq 0 ]] || die "--force is refused in Workers Builds: skipping the gate is a person's call at a terminal"
  [[ $ACCEPT_VAR_CHANGE -eq 0 ]] || die "--accept-var-change is refused in Workers Builds: a meant var change is deployed by hand"
  ci_checkout
  ci_worker_names
  ci_toolchain
  if [[ $DRY_RUN -eq 0 && -z "${EDGE_DEPLOY_API_TOKEN:-}" ]]; then
    die "the build secret EDGE_DEPLOY_API_TOKEN is not set (the build's own token cannot migrate D1); nothing was deployed"
  fi
fi
unset WRANGLER_CI_OVERRIDE_NAME WRANGLER_CI_MATCH_TAG WRANGLER_CI_GENERATE_PREVIEW_ALIAS

[[ -n "$SHA" ]] || SHA="$(verified_sha)"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "no 40-hex BUILD_SHA to stamp (got \"$SHA\"); pass --sha"

cd "$EDGE_DIR"
export CI=1 WRANGLER_SEND_METRICS=false

echo "edge-deploy: $ENV_NAME, BUILD_SHA ${SHA:0:7}$([[ $DRY_RUN -eq 1 ]] && echo ', dry run')"

deploy_api() {
  env ${CI_MATCH_TAG:+"WRANGLER_CI_MATCH_TAG=$CI_MATCH_TAG"} $WRANGLER deploy -c wrangler.api.jsonc --env "$ENV_NAME" --var "BUILD_SHA:$SHA" "$@"
}

deploy_admin() {
  $WRANGLER deploy -c wrangler.admin.jsonc --env "$ENV_NAME" --var "BUILD_SHA:$SHA" "$@"
}

gate() {
  local evidence status=0
  evidence="$(wb_gate_passed "$SHA" "$(git rev-parse --verify --quiet 'HEAD^{tree}')")" || status=$?
  if [[ $status -eq 2 ]]; then
    die "cannot ask GitHub, so nothing here can be verified; nothing was deployed"
  fi
  [[ -n "$evidence" ]] || die "refusing ${SHA:0:7}: GitHub shows no passing gate for the checkout's tree (the gate/tree status on main's commit, CD-280). Merge it through a pull request and let gate-main pass, then re-run; --force deploys it anyway"
  if ! git cat-file -e "${SHA}^{commit}" 2>/dev/null; then
    local depth=()
    [[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" != true ]] || depth=(--depth=1)
    echo "edge-deploy: the clone does not hold ${SHA:0:7}; fetching it from origin"
    git fetch --quiet ${depth[@]+"${depth[@]}"} origin "+$SHA:refs/edge-deploy/$SHA" || die "cannot fetch ${SHA:0:7} from origin, so its tree cannot be compared; nothing was deployed"
  fi
  local want have
  want="$(git rev-parse --verify --quiet "${SHA}^{tree}" || true)"
  have="$(git rev-parse --verify --quiet 'HEAD^{tree}' || true)"
  [[ -n "$want" && "$want" == "$have" ]] || die "refusing: the checkout's tree (HEAD $(git rev-parse --short HEAD 2>/dev/null || echo none)) is not ${SHA:0:7}'s tree, so what would ship is not what was verified. Check out ${SHA:0:7} (or its promotion merge)"
  clean_checkout
  echo "edge-deploy: ${SHA:0:7} is verified ($evidence) and the checkout carries its tree"
}

clean_checkout() {
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "refusing: the checkout has uncommitted changes, which would ship unverified. Commit or discard them"
  local untracked
  untracked="$(git ls-files --others --exclude-standard -- .)"
  if [[ -n "$untracked" ]]; then
    echo "edge-deploy: refusing: untracked files (git does not track them) sit in $EDGE_DIR, and wrangler would ship them (a migration there is applied to every D1 database). Remove them, or commit and verify them:" >&2
    printf '  %s\n' $untracked >&2
    exit 4
  fi
}

ci_pushed() {
  local second
  second="$(second_parent "$(git rev-parse HEAD)")"
  [[ -n "$second" && "$second" == "$SHA" ]] || die "refusing: $DEPLOY_BRANCH's tip $(git rev-parse --short HEAD) is not a promotion merge stamping ${SHA:0:7} (one has the verified commit as its second parent, that commit's tree as its tree), so nothing says what passed. Nothing was deployed"
  if ! git cat-file -e "${SHA}^{commit}" 2>/dev/null; then
    echo "edge-deploy: the clone does not hold ${SHA:0:7}; fetching it from origin for the tree comparison"
    ci_fetch "$SHA" || die "cannot fetch ${SHA:0:7} from origin, so the checkout's tree cannot be compared with it; nothing was deployed"
  fi
  local want have
  want="$(git rev-parse --verify --quiet "${SHA}^{tree}" || true)"
  have="$(git rev-parse --verify --quiet 'HEAD^{tree}' || true)"
  [[ -n "$want" && "$want" == "$have" ]] || die "refusing: the checkout's tree is not ${SHA:0:7}'s tree, so what would ship is not what /health would report. Nothing was deployed"
  clean_checkout
  echo "edge-deploy: Workers Builds deploys what the release workflow pushed to $DEPLOY_BRANCH, a promotion merge carrying ${SHA:0:7}'s tree: ${SHA:0:7} passed checks and gate before that push, and the gate is not re-checked here (owner, 5 Oct, CD-215)"
}

if [[ $DRY_RUN -eq 1 && $GATE_DRY_RUN -eq 0 ]]; then
  :
elif [[ $FORCE -eq 1 ]]; then
  echo "!!!! edge-deploy: --force: deploying ${SHA:0:7} WITHOUT the gate" >&2
elif [[ $IN_CI -eq 1 ]]; then
  ci_pushed
else
  gate
fi

if [[ $IN_CI -eq 1 ]]; then
  echo "edge-deploy: 0/3 installing @wg/edge, @wg/admin and their workspace dependencies"
  (cd "$REPO_ROOT" && $PNPM install --frozen-lockfile --filter "@wg/edge..." --filter "@wg/admin...")
fi

echo "edge-deploy: 1/3 building the workspace packages and the admin app"
$PNPM --filter "@wg/edge^..." run build
$PNPM --filter @wg/admin run "$([[ $DRY_RUN -eq 1 ]] && echo build || echo build:release)"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "edge-deploy: 2/3 skipped (dry run: no migration)"
  out="$(mktemp -d)"
  trap 'rm -rf "$out"' EXIT
  echo "edge-deploy: 3/3 bundling auth, admin, then api"
  $WRANGLER deploy -c wrangler.auth.jsonc --env "$ENV_NAME" --var "BUILD_SHA:$SHA" --dry-run --outdir "$out/auth"
  deploy_admin --dry-run --outdir "$out/admin"
  deploy_api --dry-run --outdir "$out/api"
  echo "edge-deploy: dry run ok — the three Workers bundle"
  exit 0
fi

if [[ $IN_CI -eq 1 ]]; then
  export CLOUDFLARE_API_TOKEN="$EDGE_DEPLOY_API_TOKEN"
fi

if [[ $ACCEPT_VAR_CHANGE -eq 1 ]]; then
  echo "edge-deploy: --accept-var-change: the live vars are not compared"
else
  guard=0
  $LIVE_VARS --env "$ENV_NAME" --dir "$EDGE_DIR" || guard=$?
  case "$guard" in
    0) echo "edge-deploy: the configured vars of $ENV_NAME equal what runs live" ;;
    3) die "the configured vars of $ENV_NAME differ from what runs live (above); nothing was deployed. Fix the config, or pass --accept-var-change if the change is meant" ;;
    *) die "the live vars of $ENV_NAME could not be compared (above); nothing was deployed. Pass --accept-var-change only if you know what runs live" ;;
  esac
fi

if [[ "$ENV_NAME" == dev ]]; then
  $TRANSFER_GUARD --dir "$EDGE_DIR" || die "dev is not deployed before production has taken its Durable Objects (above)"
fi

echo "edge-deploy: 2/3 D1 migrations, every database of $ENV_NAME"
WRANGLER="$WRANGLER" $NODE scripts/d1-migrate.mjs all --env "$ENV_NAME" --remote
WRANGLER="$WRANGLER" $NODE scripts/d1-migrate.mjs all --config wrangler.admin.jsonc --env "$ENV_NAME" --remote

echo "edge-deploy: 3/3 deploying auth, admin, then api"
# The very first deploy of an environment meets a cycle: `auth` binds `api`'s MailRouter class and
# `api` binds the `auth` service. Cloudflare then refuses `auth` (code 10061, the class's script does
# not exist). That one time: `auth` without that binding, then `api`, then `auth` in full.
auth_log="$(mktemp)"
admin_log="$(mktemp)"
trap 'rm -f "$auth_log" "$admin_log"' EXIT
if ! $WRANGLER deploy -c wrangler.auth.jsonc --env "$ENV_NAME" --var "BUILD_SHA:$SHA" 2>&1 | tee "$auth_log"; then
  grep -q 'code: 10061' "$auth_log" || die "the auth deploy failed"
  echo "edge-deploy: first deploy of $ENV_NAME — bootstrapping auth without its MailRouter binding"
  mkdir -p .wrangler
  $NODE -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('wrangler.auth.jsonc', 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n'));
delete c.env[process.argv[1]].durable_objects;
c.main = '../' + c.main;
fs.writeFileSync('.wrangler/auth-bootstrap.jsonc', JSON.stringify(c, null, 2));" "$ENV_NAME"
  $WRANGLER deploy -c .wrangler/auth-bootstrap.jsonc --env "$ENV_NAME" --var "BUILD_SHA:$SHA"
  deploy_api
  $WRANGLER deploy -c wrangler.auth.jsonc --env "$ENV_NAME" --var "BUILD_SHA:$SHA"
fi
# `admin` binds `api`'s Durable Object classes by script name, so the first deploy of a class the
# admin binds meets the same refusal (code 10061) while `api` does not export it yet. That one time:
# `api`, then `admin` again; a second refusal is a binding `api` never exports, and stops here.
if deploy_admin 2>&1 | tee "$admin_log"; then
  deploy_api
else
  grep -q 'code: 10061' "$admin_log" || die "the admin deploy failed"
  echo "edge-deploy: the admin Worker binds a Durable Object class the api Worker does not export yet (code 10061): deploying api first, then admin"
  deploy_api
  if ! deploy_admin 2>&1 | tee "$admin_log"; then
    grep -q 'code: 10061' "$admin_log" && die "the admin deploy is still refused (code 10061) after api deployed: a Durable Object class the admin binds is not exported by the api Worker. Check the admin's durable_objects bindings against the classes api exports"
    die "the admin deploy failed after api deployed"
  fi
fi
echo "edge-deploy: deployed ${SHA:0:7} to $ENV_NAME"
