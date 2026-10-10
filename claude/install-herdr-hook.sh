#!/bin/sh
# Install herdr's Claude hook script into ~/.claude/hooks. The shared
# settings.json (claude/settings.json) already registers it portably, so
# `herdr integration install claude` runs against a throwaway config dir and
# only its hook script is kept: herdr never edits the shared file.

set -eu

command -v herdr >/dev/null 2>&1 || exit 0

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

CLAUDE_CONFIG_DIR="$tmp" herdr integration install claude >/dev/null
mkdir -p "$HOME/.claude/hooks"
install -m 755 "$tmp/hooks/herdr-agent-state.sh" "$HOME/.claude/hooks/herdr-agent-state.sh"
