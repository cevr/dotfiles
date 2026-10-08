#!/bin/sh
set -eu
plugin_dir=$(CDPATH='' cd -- "$(dirname "$0")/.." && pwd)
test_dir=$(mktemp -d)
mkdir "$test_dir/personal" "$test_dir/work" "$test_dir/custom"
printf '%s\n' '{"statusLine":{"type":"command","command":"~/.claude/statusline-git.sh","padding":0},"permissions":{"defaultMode":"auto"}}' > "$test_dir/personal/settings.json"
ln -s "$test_dir/personal/settings.json" "$test_dir/work/settings.json"
printf '%s\n' '{"statusLine":{"type":"command","command":"my-custom-statusline"}}' > "$test_dir/custom/settings.json"
sh "$plugin_dir/install.sh" "$test_dir/personal" "$test_dir/work" "$test_dir/custom"
test -L "$test_dir/work/settings.json"
jq -e '.statusLine == null and .permissions.defaultMode == "auto"' "$test_dir/personal/settings.json" >/dev/null
jq -e '.statusLine.command == "my-custom-statusline"' "$test_dir/custom/settings.json" >/dev/null
sh "$plugin_dir/install.sh" "$test_dir/personal" "$test_dir/work"
sh "$plugin_dir/install.sh" --restore-statusline "$test_dir/personal" "$test_dir/work"
jq -e '.statusLine.command == "~/.claude/statusline-git.sh" and .statusLine.padding == 0 and .permissions.defaultMode == "auto"' "$test_dir/personal/settings.json" >/dev/null
test -L "$test_dir/work/settings.json"
printf 'Statusline migration, idempotence, shared settings, custom commands and rollback passed.\n'
if command -v trash >/dev/null 2>&1; then trash "$test_dir"; fi
