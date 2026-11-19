/**
 * `~/.local/bin/opencode`: runs `binary` without the caller's Anthropic routing. The pool picks
 * the account for OpenCode's Claude requests, but the Anthropic auth plugin sends them to
 * `ANTHROPIC_BASE_URL` when it is set, and a Claude Code session on TeamClaude sets it to the
 * proxy. The background service inherits the environment of the client that starts it, so the
 * variables are dropped at every launch, not only when a restart starts the service.
 *
 * It also exports `CLAUDE_CODE_INSTALLED_VERSION` (the Anthropic auth plugin's
 * `CLAUDE_CODE_INSTALLED_ENV_VAR`) from the release the daily Claude Code install records
 * (`claude/bin/claude-daily-install`), read with shell builtins so a launch starts no process for it.
 * Only that file sets it: an inherited value is dropped, and a line other than digits and dots
 * leaves it unset. The plugin parses it strictly once per server process, so a newer Claude Code is
 * reported from the next service start.
 */
export const launcher = (binary: string, resident: string): string => {
  const quoted = `'${binary.replaceAll("'", `'\\''`)}'`
  const header = `'x-opencode-directory:${encodeURIComponent(resident).replaceAll("'", "%27")}'`
  return [
    "#!/bin/sh",
    "# Written by the update (dotfiles/opencode/mods/update/filestore/launcher.ts): it runs the installed build.",
    "unset ANTHROPIC_BASE_URL ANTHROPIC_INSECURE CLAUDE_CODE_INSTALLED_VERSION",
    "# The installed Claude Code release, as the daily install records it (dotfiles/claude/bin/claude-daily-install).",
    'claude_release_file="${XDG_STATE_HOME:-$HOME/.local/state}/claude-daily/version"',
    'if [ -r "$claude_release_file" ] && read -r claude_release <"$claude_release_file"; then',
    '  case $claude_release in',
    "  '' | *[!0-9.]*) ;;",
    "  *) CLAUDE_CODE_INSTALLED_VERSION=$claude_release && export CLAUDE_CODE_INSTALLED_VERSION ;;",
    "  esac",
    "fi",
    "unset claude_release_file claude_release",
    "# A started service loads the server plugins in its resident location (`residentConfig`).",
    'case "$1 $2" in',
    '"service start" | "service restart")',
    `  ${quoted} "$@" || exit`,
    `  ${quoted} api GET /api/location -H ${header} >/dev/null || echo "opencode: the service did not load its resident location; its plugins wait for a client" >&2`,
    "  exit 0",
    "  ;;",
    "esac",
    `exec ${quoted} "$@"`,
    "",
  ].join("\n")
}
