#!/bin/sh
# Installs workbox/bin/* into ~/.local/bin, replacing each older copy, and the workbox's shell files
# (zshenv, zshrc) into ~/.local/share/workbox, pointing ~/.zshenv and ~/.zshrc at them. Bootstrap
# runs it, and so does the fleet update after each proven install (opencode/mods/update:
# `Source.commands`), from the installed build's tree (`current.plugins/workbox/`), with --apply to
# run the fresh apply-agent-settings after. So what it installs is the files beside it: the verified
# build's, never the live checkout's, which Syncthing fills from the Mac's base and no update moves.
# A script since removed from workbox/bin is left in ~/.local/bin: nothing records which files there
# came from here.
#
# Every file is checked before any is replaced (`sh -n`, `dash -n` where there is a dash, `bash -n`,
# `zsh -n`, and a scratch `zsh -c true` that reads the candidate zshenv): one that fails is named,
# nothing is replaced and the script exits 1, so the update logs it. Each file is then written beside
# its target as `.<name>.<pid>` and renamed over it: an agent that starts a command, or a shell that
# reads a file, during an install sees the old file or the new one, whole, never none or a part, and
# a running `sh` keeps reading the old one. A home ~/.zshenv or ~/.zshrc that is a file of its own
# (not a link) is never overwritten: the script says what to do about it and exits 1.

set -eu

workbox_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
local_bin_dir="$HOME/.local/bin"
# The installed OpenCode build's plugin tree, a link the update moves with each
# install record (opencode/mods/update/filestore/stage.ts `CURRENT_TREE`).
current_tree="$HOME/.local/share/opencode-prime/current.plugins"
# The shell files' installed copies: a stable path the home's links name, so they never
# point into a tree a prune takes away or into a checkout that lags.
shell_dir="$HOME/.local/share/workbox"

refused=""
refuse() {
  printf 'install-bin: refused %s: %s\n' "$1" "$2" >&2
  refused=1
}

# The syntax check of a script, by the shell its first line names; a script of another
# language (bun, node) has none here.
check_script() {
  first=$(head -n 1 "$1")
  case $first in
    '#!/bin/sh'* | '#!/usr/bin/env sh'*)
      sh -n "$1" 2>/dev/null || refuse "$1" 'sh -n fails'
      if command -v dash >/dev/null 2>&1; then
        dash -n "$1" 2>/dev/null || refuse "$1" 'dash -n fails'
      fi
      ;;
    '#!/bin/bash'* | '#!/usr/bin/env bash'*)
      bash -n "$1" 2>/dev/null || refuse "$1" 'bash -n fails'
      ;;
    '#!/bin/zsh'* | '#!/usr/bin/env zsh'*)
      zsh -n "$1" 2>/dev/null || refuse "$1" 'zsh -n fails'
      ;;
  esac
}

# A candidate zshenv must parse and must start a shell that prints nothing and exits 0: it
# is read by every zsh, a `zsh -c` one too. It runs in a scratch HOME with no environment.
check_zshenv() {
  zsh -n "$1" 2>/dev/null || {
    refuse "$1" 'zsh -n fails'
    return 0
  }
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/install-bin-zshenv.XXXXXX")
  cp "$1" "$scratch/.zshenv"
  said=$(cd "$scratch" && env -i HOME="$scratch" ZDOTDIR="$scratch" PATH=/usr/bin:/bin zsh -c true 2>&1) && status=0 || status=$?
  rm -r "$scratch"
  if [ "$status" -ne 0 ] || [ -n "$said" ]; then
    refuse "$1" "a zsh that reads it exits $status and prints: $said"
  fi
}

for script in "$workbox_dir"/bin/*; do
  check_script "$script"
done
for name in zshenv zshrc; do
  [ -f "$workbox_dir/$name" ] || continue
  zsh -n "$workbox_dir/$name" 2>/dev/null || refuse "$workbox_dir/$name" 'zsh -n fails'
done
[ -f "$workbox_dir/zshenv" ] && check_zshenv "$workbox_dir/zshenv"
if [ -n "$refused" ]; then
  printf 'install-bin: nothing was installed; every file stays as it was\n' >&2
  exit 1
fi

# Copies `$1` to `$2` with mode `$3`: written beside the target, then renamed over it.
put() {
  install -m "$3" "$1" "$(dirname "$2")/.$(basename "$2").$$"
  mv -f "$(dirname "$2")/.$(basename "$2").$$" "$2"
}

mkdir -p "$local_bin_dir"
for script in "$workbox_dir"/bin/*; do
  put "$script" "$local_bin_dir/$(basename "$script")" 755
done

# The home's link is made only where there is a link or nothing: a real file is the owner's.
owned=""
mkdir -p "$shell_dir"
for name in zshenv zshrc; do
  [ -f "$workbox_dir/$name" ] || continue
  put "$workbox_dir/$name" "$shell_dir/$name" 644
  home_file="$HOME/.$name"
  if [ -L "$home_file" ] || [ ! -e "$home_file" ]; then
    if [ "$(readlink "$home_file" 2>/dev/null || true)" != "$shell_dir/$name" ]; then
      ln -sfn "$shell_dir/$name" "$home_file.$$"
      mv -f "$home_file.$$" "$home_file"
    fi
  else
    printf 'install-bin: %s is a file of its own, not the link to %s, so new shells do not read the installed %s. It was left as it is. To fix: move what you want to keep from it into ~/.config/secrets.env (sourced by zshenv), then `mv %s %s.mine`; the next install links it.\n' \
      "$home_file" "$shell_dir/$name" "$name" "$home_file" "$home_file" >&2
    owned=1
  fi
done

if [ "${1:-}" = --apply ]; then
  "$local_bin_dir/apply-agent-settings"
fi

# rex-show is part of the plugins (opencode/mods/rex): it runs from the build
# that runs, through its tree, once it holds the file; with none, no link is
# made and one that is there stays. This script is its one owner here.
if [ -e "$current_tree/opencode/cmd/rex/show.ts" ]; then
  ln -sf "$current_tree/opencode/cmd/rex/show.ts" "$local_bin_dir/rex-show.$$"
  mv -f "$local_bin_dir/rex-show.$$" "$local_bin_dir/rex-show"
fi

[ -z "$owned" ] || exit 1
