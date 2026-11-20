#!/bin/sh
# Installs workbox/bin/* into ~/.local/bin, replacing each older copy. Bootstrap
# runs it, and so does the fleet update after each proven install
# (opencode/mods/update: `Source.commands`), with --apply to run the fresh
# apply-agent-settings after. A script since removed from workbox/bin is left in
# ~/.local/bin: nothing records which files there came from here.

set -eu

workbox_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
local_bin_dir="$HOME/.local/bin"
# The installed OpenCode build's plugin tree, a link the update moves with each
# install record (opencode/mods/update/filestore/stage.ts `CURRENT_TREE`).
current_tree="$HOME/.local/share/opencode-prime/current.plugins"

mkdir -p "$local_bin_dir"
for script in "$workbox_dir"/bin/*; do
  install -m 755 "$script" "$local_bin_dir/$(basename "$script")"
done

if [ "${1:-}" = --apply ]; then
  "$local_bin_dir/apply-agent-settings"
fi

# rex-show is part of the plugins (opencode/mods/rex): it runs from the build
# that runs, through its tree, once there is one; apply-agent-settings links
# the checkout's, which stays for a host before its first tree install.
if [ -e "$current_tree/opencode/cmd/rex/show.ts" ]; then
  ln -sf "$current_tree/opencode/cmd/rex/show.ts" "$local_bin_dir/rex-show"
fi
