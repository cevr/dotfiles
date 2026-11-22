#!/bin/sh
# Installs workbox/bin/* into ~/.local/bin, replacing each older copy, and the workbox's shell files
# (zshenv, zshrc) into ~/.local/share/workbox, pointing ~/.zshenv and ~/.zshrc at them. Bootstrap
# runs it, and so does the fleet update after each proven install (opencode/mods/update:
# `Source.commands`), from the installed build's tree (`current.plugins/workbox/`), with --apply to
# run the fresh apply-agent-settings after. So what it installs is the files beside it: the verified
# build's, never the live checkout's, which Syncthing fills from the Mac's base and no update moves.
# A script since removed from workbox/bin is left in ~/.local/bin: nothing records which files there
# came from here.

set -eu

workbox_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
local_bin_dir="$HOME/.local/bin"
# The installed OpenCode build's plugin tree, a link the update moves with each
# install record (opencode/mods/update/filestore/stage.ts `CURRENT_TREE`).
current_tree="$HOME/.local/share/opencode-prime/current.plugins"
# The shell files' installed copies: a stable path the home's links name, so they never
# point into a tree a prune takes away or into a checkout that lags.
shell_dir="$HOME/.local/share/workbox"

mkdir -p "$local_bin_dir"
for script in "$workbox_dir"/bin/*; do
  install -m 755 "$script" "$local_bin_dir/$(basename "$script")"
done

# Each shell file is copied in beside its installed copy, then renamed over it: a shell
# reading the old copy reads it whole, and the next shell reads the new one. The home's
# link is made only where there is a link or nothing: a real file is the owner's.
mkdir -p "$shell_dir"
for name in zshenv zshrc; do
  [ -f "$workbox_dir/$name" ] || continue
  install -m 644 "$workbox_dir/$name" "$shell_dir/.$name.$$"
  mv -f "$shell_dir/.$name.$$" "$shell_dir/$name"
  home_file="$HOME/.$name"
  if [ -L "$home_file" ] || [ ! -e "$home_file" ]; then
    if [ "$(readlink "$home_file" 2>/dev/null || true)" != "$shell_dir/$name" ]; then
      ln -sfn "$shell_dir/$name" "$home_file.$$"
      mv -f "$home_file.$$" "$home_file"
    fi
  else
    printf 'install-bin: %s is a file, not a link; left as it is (the installed copy is %s)\n' "$home_file" "$shell_dir/$name" >&2
  fi
done

if [ "${1:-}" = --apply ]; then
  "$local_bin_dir/apply-agent-settings"
fi

# rex-show is part of the plugins (opencode/mods/rex): it runs from the build
# that runs, through its tree, once it holds the file; with none, no link is
# made and one that is there stays. This script is its one owner here.
if [ -e "$current_tree/opencode/cmd/rex/show.ts" ]; then
  ln -sf "$current_tree/opencode/cmd/rex/show.ts" "$local_bin_dir/rex-show"
fi
