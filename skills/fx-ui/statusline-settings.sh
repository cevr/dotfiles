#!/bin/sh
set -eu

mode=$1
config_dir=$2
settings_file="$config_dir/settings.json"
backup_file="$config_dir/.fx-ui-statusline.json"
[ -f "$settings_file" ] || exit 0
# Both accounts may share this file through a symlink.
settings_file=$(realpath "$settings_file")
case "$mode" in
  migrate)
    jq -e '.statusLine.type == "command" and (.statusLine.command | endswith("/statusline-git.sh"))' "$settings_file" >/dev/null 2>&1 || exit 0
    if [ ! -f "$backup_file" ]; then
      (umask 077; jq '.statusLine' "$settings_file" > "$backup_file")
    fi
    ;;
  restore)
    [ -f "$backup_file" ] || exit 0
    # Do not replace a statusline the person configured after migration.
    jq -e '.statusLine == null' "$settings_file" >/dev/null || exit 0
    ;;
  *) printf 'Unknown statusline mode: %s\n' "$mode" >&2; exit 1 ;;
esac
settings_tmp=$(mktemp "$settings_file.fx-ui.XXXXXX")
trap 'rm -f "$settings_tmp"' EXIT HUP INT TERM
if [ "$mode" = migrate ]; then
  jq 'del(.statusLine)' "$settings_file" > "$settings_tmp"
else
  jq --slurpfile previous "$backup_file" '.statusLine = $previous[0]' "$settings_file" > "$settings_tmp"
fi
chmod 600 "$settings_tmp"
mv "$settings_tmp" "$settings_file"
