/**
 * `~/.local/bin/opencode`: runs `binary` without the caller's Anthropic routing. The pool picks
 * the account for OpenCode's Claude requests, but the Anthropic auth plugin sends them to
 * `ANTHROPIC_BASE_URL` when it is set, and a Claude Code session on TeamClaude sets it to the
 * proxy. The background service inherits the environment of the client that starts it, so the
 * variables are dropped at every launch, not only when a restart starts the service.
 */
export const launcher = (binary: string, resident: string): string => {
  const quoted = `'${binary.replaceAll("'", `'\\''`)}'`
  const header = `'x-opencode-directory:${encodeURIComponent(resident).replaceAll("'", "%27")}'`
  return [
    "#!/bin/sh",
    "# Written by the update (dotfiles/opencode/mods/update/filestore/launcher.ts): it runs the installed build.",
    "unset ANTHROPIC_BASE_URL ANTHROPIC_INSECURE",
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
