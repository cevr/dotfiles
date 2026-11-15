#!/bin/sh
# Installs workbox/bin/* into ~/.local/bin, replacing each older copy. Bootstrap
# runs it, and so does the fleet install each time it moves the workbox's
# dotfiles checkout (opencode/mods/update/git/source.ts), with --apply to run the
# fresh apply-agent-settings after. A script since removed from workbox/bin is
# left in ~/.local/bin: nothing records which files there came from here.

set -eu

workbox_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
local_bin_dir="$HOME/.local/bin"

mkdir -p "$local_bin_dir"
for script in "$workbox_dir"/bin/*; do
  install -m 755 "$script" "$local_bin_dir/$(basename "$script")"
done

if [ "${1:-}" = --apply ]; then
  "$local_bin_dir/apply-agent-settings"
fi
