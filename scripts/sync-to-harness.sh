#!/usr/bin/env bash
# Development loop: push this repo's source into the harness checkout
# (which owns the mounted composition), rebuild the harness artifacts
# (including Typert generation), and vendor the regenerated Typert
# quartet back here.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="${HARNESS:-/Users/heyue/deepseek-harness}"
PKG="$HARNESS/packages/devflow/devflow"

rsync -a --delete --exclude 'client/tsconfig.json' "$REPO_ROOT/packages/devflow/src/" "$PKG/src/"
rsync -a --delete "$REPO_ROOT/packages/devflow/tests/" "$PKG/tests/"

(cd "$HARNESS" \
  && npm run build:lib:host >/dev/null \
  && npm run build:lib:client >/dev/null \
  && npm run build:web >/dev/null)
echo "harness rebuilt"

bash "$REPO_ROOT/scripts/vendor-typert.sh"
echo "done: restart DSH (or reload the web page) to pick up new artifacts"
