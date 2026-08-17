#!/usr/bin/env bash
# Dev loop: install this repo's package into the dsh web profile as a link,
# then (re)build it. The profile's composition row `dsh-devflow` resolves to
# packages/devflow through the link; the harness web server serves the
# browser bundle straight from this repo's lib/client.js (the /plugins route
# is no-cache), so iteration is: edit → pnpm build → reload the page.
# No harness-checkout modification is involved anywhere.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/web}"

(cd "$REPO_ROOT" && pnpm install && pnpm build)
(cd "$PROFILE" && pnpm add "dsh-devflow@link:$REPO_ROOT/packages/devflow")
echo "done: composition row 'dsh-devflow' resolves to this repo"
echo "restart DSH (dsh web) after a first link / row change; code-only iteration just reloads the page"
