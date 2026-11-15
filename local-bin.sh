#!/bin/sh
# Links the dotfiles' personal commands into ~/.local/bin. install.sh runs it, and so does the
# Mac's fleet install each time it moves the dotfiles checkout (opencode/mods/update/git/source.ts),
# so a command added here reaches the Mac without a rerun of install.sh. Idempotent. A command since
# removed from this list keeps its link (nothing records which links came from here).

set -eu

dotfiles_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
local_bin_dir="$HOME/.local/bin"

mkdir -p "$local_bin_dir"
ln -sf "$dotfiles_dir/skills/track-work-hours/scripts/hours" "$local_bin_dir/hours"
# The daemon the codex mod drives Codex threads through.
ln -sf "$dotfiles_dir/claude/mods/codex/bridge/bridge.ts" "$local_bin_dir/codex-bridge"
# Shows work in a Rex pane beside the caller's (opencode/mods/rex).
ln -sf "$dotfiles_dir/opencode/cmd/rex/show.ts" "$local_bin_dir/rex-show"
