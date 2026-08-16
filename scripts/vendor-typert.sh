#!/usr/bin/env bash
# Copy the Typert wire quartet generated inside the harness checkout into
# this repo, rewriting the scoped package name to the unscoped one so the
# host/client artifacts stay self-consistent here.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS_PKG="${HARNESS_PKG:-/Users/heyue/deepseek-harness/packages/devflow/devflow}"
DEST="$REPO_ROOT/packages/devflow/wire"
mkdir -p "$DEST"
for f in typert.host.js typert.host.d.ts typert.remote-client.js typert.remote-client.d.ts; do
  sed 's#@deepseek-ai/dsh-devflow#dsh-devflow#g' "$HARNESS_PKG/lib/$f" > "$DEST/$f"
done
echo "vendored typert quartet -> $DEST"
mkdir -p "$REPO_ROOT/packages/devflow/lib"
cp "$DEST"/typert.* "$REPO_ROOT/packages/devflow/lib/"
