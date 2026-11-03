#!/usr/bin/env bash
# One-time setup on wb, run as root: the `wb-release` runner gets an OS user of its own
# (CD-269; owner, 8 Oct). The release and deploy jobs hold
# the write tokens and secrets; the `wb` runners run branch code as the shared
# account. With its own user, HOME, runner tool cache and pnpm store, nothing a `wb` job
# leaves behind (~/.gitconfig, the pnpm store, _tool/node, the runner's own binaries) is
# ever used by a release job. Nothing is copied from the shared account's HOME.
#
#   sudo infra/scripts/wb-release-user.sh --dry-run [--from <shared account>]
#   sudo infra/scripts/wb-release-user.sh --from <shared account> \
#        --token <registration token> --tarball <actions-runner-linux-x64-*.tar.gz> --sha256 <hex>
#
# The token, the tarball's URL and its SHA-256 are the ones Settings → Actions → Runners →
# New self-hosted runner shows (Linux x64). Idempotent: each item is checked first and only a
# missing one is changed; a second run prints `ok` for everything. Lines are
# `ok|would|did|need <item>`. In order:
#   - the user `ghrelease` (system user, own group, no skeleton) and its HOME, 0700, empty;
#   - its own pnpm store (`~ghrelease/.pnpm-store`, set in the runner's .env) and TMPDIR
#     (`~ghrelease/wg-verify/tmp`; wb's /tmp is noexec);
#   - Node 22 on the system PATH (root's to install; never the shared account's);
#   - a FRESH runner in `~ghrelease/actions-runner-release` from the tarball (SHA-256
#     checked), registered as `wb-release-1` with the label `wb-release` and `--replace`, so
#     the old registration is retired; its tool cache is its own `_work/_tool`;
#   - the old runner's service retired (`systemctl disable --now`, its unit file removed,
#     `daemon-reload`): the new runner has the same name, so the same unit, which `svc.sh
#     install` would refuse while the old one is there; then the new service, installed to run
#     as `ghrelease`;
#   - Chromium's runtime system libraries (libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64
#     libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1), each checked with `dpkg -s`, the
#     missing ones installed as root with apt (`DEBIAN_FRONTEND=noninteractive apt-get install -y`),
#     before Chromium: `ghrelease` must not load libraries from the shared account's HOME;
#   - Playwright's Chromium for `ghrelease` (the smoke walk), at the app's version;
#   - last, the old runner's folder in the shared account's HOME (`~<from>/actions-runner-release`,
#     HOME from `getent passwd`) removed (its credentials were replaced). Root never runs anything
#     from that folder: any `wb` job can write it.
# No hidepid, no runner group, no ephemeral runner: the owner chose this middle ground.
# Exit: 0 done (or a dry run), 1 something left by hand, 2 usage or not root.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_NAME=ghrelease
HOME_ROOT="${WB_RELEASE_HOME_ROOT:-/home}"
NEW_HOME="$HOME_ROOT/$USER_NAME"
RUNNER="$NEW_HOME/actions-runner-release"
STORE="$NEW_HOME/.pnpm-store"
VERIFY="$NEW_HOME/wg-verify"
URL=https://github.com/parlornights/CrookedDuke
# The unit the runner's svc.sh names for a repository runner: actions.runner.<owner>-<repo>.<runner name>.service.
UNIT=actions.runner.parlornights-CrookedDuke.wb-release-1.service
UNIT_DIR="${WB_RELEASE_UNIT_DIR:-/etc/systemd/system}"
SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

DRY=0
FROM="${SUDO_USER:-}"
FROM_GIVEN=0
TOKEN=''
TARBALL=''
SHA=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --from) FROM="${2:-}"; FROM_GIVEN=1; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --tarball) TARBALL="${2:-}"; shift 2 ;;
    --sha256) SHA="${2:-}"; shift 2 ;;
    -h | --help) awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "wb-release-user: unknown flag: $1" >&2; exit 2 ;;
  esac
done
if [[ $DRY -eq 0 && "$(id -u)" != 0 ]]; then
  echo "wb-release-user: run it as root (sudo), or with --dry-run" >&2
  exit 2
fi
if [[ "$FROM" == "$USER_NAME" || "$FROM" == root ]]; then
  echo "wb-release-user: --from names the shared account that ran the runner, not $FROM" >&2
  exit 2
fi

TODO=0
say() { printf '%-5s %s\n' "$1" "$2"; }
change() { # change <what> <command...>
  local what="$1"; shift
  if [[ $DRY -eq 1 ]]; then say would "$what"; return 0; fi
  if "$@"; then say did "$what"; else say need "$what (failed)"; TODO=$((TODO + 1)); fi
}
need() { say need "$1"; TODO=$((TODO + 1)); }
# A command as ghrelease, with its own HOME and the system PATH: nothing of root's or the shared account's environment.
# (A dry run without root reads with the same clean environment, as the caller.)
as_user() {
  local run=(env -i HOME="$NEW_HOME" USER="$USER_NAME" LOGNAME="$USER_NAME" PATH="$SYSTEM_PATH" LANG=C.UTF-8 "$@")
  if [[ "$(id -u)" == 0 ]]; then sudo -u "$USER_NAME" -H "${run[@]}"; else "${run[@]}"; fi
}
mine() { [[ -d "$1" && "$(stat -c '%U %a' "$1")" == "$USER_NAME 700" ]]; }
own_dir() { install -d -o "$USER_NAME" -g "$USER_NAME" -m 0700 "$1"; }

# --- the user and its HOME ----------------------------------------------------
if id -u "$USER_NAME" >/dev/null 2>&1; then
  say ok "user $USER_NAME"
else
  change "create the user $USER_NAME (system user, own group, no skeleton copied)" \
    useradd --system --user-group --no-create-home --home-dir "$NEW_HOME" --shell /bin/bash "$USER_NAME"
fi
for dir in "$NEW_HOME" "$STORE" "$VERIFY" "$VERIFY/tmp"; do
  if mine "$dir"; then say ok "$dir ($USER_NAME, 0700)"; else change "create $dir ($USER_NAME, 0700, empty)" own_dir "$dir"; fi
done

# --- Node 22 from the system, never from the shared account -------------------
if [[ "$(as_user node --version 2>/dev/null | sed -E 's/^v?([0-9]+).*/\1/')" == 22 ]]; then
  say ok "Node 22 on the system PATH"
else
  need "Node 22 on the system PATH ($SYSTEM_PATH) for $USER_NAME: install it as root; the shared account's Node is not used"
fi

# --- a fresh runner of its own ------------------------------------------------
unpack() {
  [[ "$(sha256sum "$TARBALL" | cut -d' ' -f1)" == "$SHA" ]] || { echo "wb-release-user: $TARBALL does not match --sha256" >&2; return 1; }
  own_dir "$RUNNER" && tar -xzf "$TARBALL" -C "$RUNNER" && chown -R "$USER_NAME:$USER_NAME" "$RUNNER"
}
register() {
  (cd "$RUNNER" && as_user ./config.sh --url "$URL" --token "$TOKEN" --name wb-release-1 --labels wb-release --unattended --replace)
}
if [[ -f "$RUNNER/.runner" ]]; then
  say ok "runner wb-release-1 registered in $RUNNER"
elif [[ -n "$TOKEN" && -n "$TARBALL" && -n "$SHA" ]] || [[ $DRY -eq 1 ]]; then
  [[ -f "$RUNNER/config.sh" ]] || change "unpack a fresh runner into $RUNNER (SHA-256 checked)" unpack
  change "register wb-release-1, label wb-release, replacing the old registration" register
else
  need "the runner: pass --token, --tarball and --sha256 from Settings → Actions → Runners → New self-hosted runner"
fi

# The pnpm store, through the runner's environment for every job; the tool cache stays the runner's own _work/_tool.
store_env() { touch "$RUNNER/.env" && echo "npm_config_store_dir=$STORE" >>"$RUNNER/.env" && chown "$USER_NAME:$USER_NAME" "$RUNNER/.env"; }
if [[ -f "$RUNNER/.env" ]] && grep -qx "npm_config_store_dir=$STORE" "$RUNNER/.env"; then
  say ok "the runner's jobs use $STORE"
else
  change "point the runner's jobs at $STORE (.env)" store_env
fi

# The old runner's service has the new one's unit name: retired through systemd, never through the old folder's svc.sh.
retire_unit() { systemctl disable --now "$UNIT" && rm -f "$UNIT_DIR/$UNIT" && systemctl daemon-reload; }
service() { (cd "$RUNNER" && ./svc.sh install "$USER_NAME" && ./svc.sh start); }
runs_as="$(systemctl show -p User --value "$UNIT" 2>/dev/null || true)"
if [[ -f "$UNIT_DIR/$UNIT" && "$runs_as" != "$USER_NAME" ]]; then
  if [[ $DRY -eq 1 || -f "$RUNNER/.runner" ]]; then
    change "retire the old runner's service $UNIT (runs as ${runs_as:-?}): disable --now, remove its unit file, daemon-reload" retire_unit
    [[ $DRY -eq 1 ]] || runs_as=''
  else
    need "the old runner's service $UNIT keeps running until the new runner is registered"
  fi
fi
if [[ "$runs_as" == "$USER_NAME" ]] && systemctl is-active --quiet "$UNIT"; then
  say ok "service $UNIT runs as $USER_NAME"
elif [[ -f "$RUNNER/.runner" || $DRY -eq 1 ]]; then
  change "install and start the runner's service as $USER_NAME" service
else
  need "the runner's service (after the runner is registered)"
fi

# --- Chromium's system libraries, installed by root ---------------------------
LIBS=(libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1)
missing=()
for lib in "${LIBS[@]}"; do dpkg -s "$lib" >/dev/null 2>&1 || missing+=("$lib"); done
install_libs() { DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing[@]}"; }
if [[ ${#missing[@]} -eq 0 ]]; then
  say ok "Chromium's system libraries"
else
  change "install Chromium's system libraries (${missing[*]}) with apt" install_libs
fi

# --- Chromium for the smoke walk, its own -------------------------------------
PLAYWRIGHT="$(sed -nE 's/.*"@playwright\/test": "([^"]+)".*/\1/p' "$HERE/../../apps/app/package.json")"
if compgen -G "$NEW_HOME/.cache/ms-playwright/chromium-*" >/dev/null; then
  say ok "Playwright's Chromium for $USER_NAME"
else
  change "install Playwright's Chromium $PLAYWRIGHT for $USER_NAME" \
    as_user sh -c "cd \"\$HOME\" && npx --yes playwright@$PLAYWRIGHT install chromium"
fi

# --- last: retire the runner in the shared account's HOME ---------------------
old_home="$([[ -n "$FROM" ]] && getent passwd "$FROM" | cut -d: -f6 || true)"
if [[ -z "$FROM" ]]; then
  need "the shared account (--from <account>): its old runner folder is left as it is"
elif [[ -z "$old_home" ]]; then
  need "no account $FROM on this machine (--from names the shared account)"
else
  OLD="$old_home/actions-runner-release"
  if [[ ! -e "$OLD" && $FROM_GIVEN -eq 1 ]]; then
    say ok "no runner left in $FROM's HOME ($old_home)"
  elif [[ ! -e "$OLD" ]]; then
    need "no runner folder at $OLD: name the shared account that ran it with --from"
  elif [[ $DRY -eq 1 || -f "$RUNNER/.runner" ]]; then
    change "remove the old runner folder $OLD (its registration was replaced; nothing in it is run)" rm -rf "$OLD"
  else
    need "the old runner $OLD stays until the new one is registered"
  fi
fi

if [[ $DRY -eq 1 ]]; then
  echo "wb-release-user: dry run — nothing changed"
elif [[ $TODO -gt 0 ]]; then
  echo "wb-release-user: incomplete — $TODO item(s) by hand"
  exit 1
else
  echo "wb-release-user: ok"
fi
