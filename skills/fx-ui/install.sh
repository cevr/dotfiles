#!/bin/sh
set -eu

plugin_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
mode=migrate
if [ "${1:-}" = --restore-statusline ]; then
  mode=restore
  shift
fi
if [ "$#" -eq 0 ]; then
  set -- "$HOME/.claude" "$HOME/.claude2"
fi
for config_dir do
  mkdir -p "$config_dir/skills"
  target="$config_dir/skills/fx-ui"
  # Shared skills directories already expose the plugin from dotfiles.
  if [ "$mode" = migrate ] && [ ! "$target" -ef "$plugin_dir" ]; then
    if [ -e "$target" ] && [ ! -L "$target" ]; then
      printf 'fx-ui: refusing to replace an existing directory: %s\n' "$target" >&2
      exit 1
    fi
    ln -sfn "$plugin_dir" "$target"
  fi
  sh "$plugin_dir/statusline-settings.sh" "$mode" "$config_dir"
done
printf 'fx-ui: statusline %s complete. Start a new Claude session.\n' "$mode"
