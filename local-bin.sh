#!/bin/sh
# Links the dotfiles' personal commands into ~/.local/bin. install.sh runs it, and so does the
# Mac's fleet update after each proven install (opencode/mods/update: `Source.commands`), so a command
# added here reaches the Mac without a rerun of install.sh. Idempotent. A command since removed from
# this list keeps its link (nothing records which links came from here).

set -eu

dotfiles_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
local_bin_dir="$HOME/.local/bin"
# The installed OpenCode build's plugin tree, a link the update moves with each install record
# (opencode/mods/update/filestore/stage.ts `CURRENT_TREE`): a command that is part of the plugins runs
# from the build that runs, never from this checkout, whose edits load nowhere until they are built.
current_tree="$HOME/.local/share/opencode-prime/current.plugins"

# The path of the plugins' file $1 (from opencode/): through the installed build's tree when it has
# the file, else this checkout's (a host before its first tree install).
plugin_file() {
  if [ -e "$current_tree/opencode/$1" ]; then
    printf '%s\n' "$current_tree/opencode/$1"
  else
    printf '%s\n' "$dotfiles_dir/opencode/$1"
  fi
}

mkdir -p "$local_bin_dir"
ln -sf "$dotfiles_dir/skills/track-work-hours/scripts/hours" "$local_bin_dir/hours"
# The daemon the codex mod drives Codex threads through.
ln -sf "$dotfiles_dir/claude/mods/codex/bridge/bridge.ts" "$local_bin_dir/codex-bridge"
# Shows work in a Rex pane beside the caller's (opencode/mods/rex).
ln -sf "$(plugin_file cmd/rex/show.ts)" "$local_bin_dir/rex-show"
