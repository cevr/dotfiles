#!/bin/sh
set -eu

plugin_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
mode=migrate
if [ "${1:-}" = --restore-statusline ]; then
  mode=restore
  shift
fi
if [ "$#" -eq 0 ]; then
  set -- "$HOME/.claude"
fi
# The mod itself loads through CLAUDE_CODE_PLUGIN_DIRS in claude/settings.json;
# this step only moves the legacy statusline aside (or restores it).
for config_dir do
  sh "$plugin_dir/statusline-settings.sh" "$mode" "$config_dir"
done
printf 'fx-ui: statusline %s complete. Start a new Claude session.\n' "$mode"
