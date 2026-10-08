#!/bin/sh
set -eu

plugin_dir=$(CDPATH='' cd -- "$(dirname "$0")" && pwd)
if [ "$#" -eq 0 ]; then
  set -- "$HOME/.claude" "$HOME/.claude2"
fi
for config_dir do
  mkdir -p "$config_dir/skills"
  target="$config_dir/skills/fx-ui"
  # Shared skills directories already expose the plugin from dotfiles.
  if [ "$target" -ef "$plugin_dir" ]; then
    continue
  fi
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    printf 'fx-ui: refusing to replace an existing directory: %s\n' "$target" >&2
    exit 1
  fi
  ln -sfn "$plugin_dir" "$target"
done
printf 'fx-ui installed for both Claude accounts. Start a new Claude session.\n'
