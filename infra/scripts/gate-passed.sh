#!/usr/bin/env bash
# What "the gate passed" means, in one place. Sourced by
# `edge-deploy.sh`, which refuses a commit the gate did not pass (ARCHITECTURE §20).
#
# THE GATE'S OWN STATUSES ARE THE ONLY EVIDENCE (CD-280; owner, 7 Oct).
# The `verified/<sha>` branches `pnpm verify` used to push, and the historical
# `refs/ci-ok/<sha>`, are retired: `gate-status.mjs` finds the `checks/tree` and
# `gate/tree` statuses that name the tree of <sha> (or of <tree>, the checkout a
# deploy would ship) on <sha>, its parents, or the heads of its pull requests.

# This file's directory, resolved once, absolutely, when it is sourced: a caller that later
# changes directory (edge-deploy.sh does `cd "$EDGE_DIR"`) must still find gate-status.mjs, also
# when it was started by a relative path (Workers Builds runs `bash infra/scripts/edge-deploy.sh`,
# CD-215).
WB_GATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Ask GitHub whether the tree of <sha> (or of <tree>) passed. It needs a GitHub
# token in the environment (the header of `gate-status.mjs` names them). Prints
# the evidence; 1 if the tree has not passed; 2 if GitHub cannot be asked.
# The node is WB_NODE, never NODE: pnpm and npm export NODE as their OWN executable to
# every script they run, and under a standalone pnpm that is not a node at all. A pass
# is the evidence line, never the exit code alone: a binary that prints nothing and
# exits 0 (a half-written pnpm, CD-196) passed the gate before this.
wb_gate_passed() {
  local sha="$1" tree="${2:-}" answer status
  answer="$(${WB_NODE:-node} "$WB_GATE_DIR/gate-status.mjs" check --sha "$sha" ${tree:+--tree "$tree"} 2>&1)" && status=0 || status=$?
  if [[ $status -eq 0 && "$answer" == *"passed on "* ]]; then
    echo "gate/tree ${answer##*passed on }" | head -1
    return 0
  fi
  echo "$answer" >&2
  if [[ $status -eq 0 ]]; then
    echo "gate-status: answered with no passing tree, so the gate cannot be read" >&2
    return 2
  fi
  return "$status"
}

# Fetch origin: an unreachable origin means the gate cannot be checked, and a
# gate that cannot be checked is not a gate.
wb_fetch_origin() {
  git fetch --quiet origin
}
