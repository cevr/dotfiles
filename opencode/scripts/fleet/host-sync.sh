#!/bin/bash
# fleet-install's first step on each host (scripts/fleet-install.ts): bring the dotfiles checkout to
# origin/main, then run the host step from the code it now holds (`fleet-install.ts host`).
#
#   host-sync.sh <ff|reset> <dotfiles checkout> [host step flags...]
#
# ff (the Mac): fast-forward only; a checkout that does not fast-forward fails the host.
# reset (the workbox): Syncthing keeps this tree's files in step with the Mac, so a merge can refuse
# files it already has. HEAD moves to origin/main (the index too, never the files), each tracked file
# that still differs is taken from HEAD, except the files each host keeps its own (codex/config.toml,
# skills/.system/, workbox/herdr-config.toml), and Syncthing's conflict copies are deleted.
set -u
mode=$1
checkout=$2
shift 2

fail() {
  printf 'FLEET-RESULT {"host":"%s","outcome":"failed","line":"%s: failed, %s"}\n' "$FLEET_HOST" "$FLEET_HOST" "$1"
  exit 1
}

FLEET_HOST=${FLEET_HOST:-$(hostname)}
cd "$checkout" || fail "no dotfiles checkout at $checkout"
git fetch -q origin || fail "git fetch of the dotfiles failed"
if ! git merge -q --ff-only origin/main 2>/dev/null; then
  [ "$mode" = reset ] || fail "the dotfiles checkout does not fast-forward to origin/main"
  git reset -q origin/main || fail "the dotfiles checkout could not move to origin/main"
fi
if [ "$mode" = reset ]; then
  git diff --name-only | grep -v -E '^(codex/config.toml|skills/.system/|workbox/herdr-config.toml)' | while IFS= read -r file; do
    git checkout -q -- "$file"
  done
  git ls-files --others --exclude-standard | grep -F '.sync-conflict-' | while IFS= read -r file; do
    rm -f -- "$file"
  done
fi
echo "dotfiles at $(git log --oneline -1)"
exec bun opencode/scripts/fleet-install.ts host "$@"
