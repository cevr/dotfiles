# fx-ui

A Claude Code render mod inspired by [fx](https://github.com/vercel-labs/fx) and
[Gent](https://github.com/cevr/gent). It uses Claude's
[function-hook mod API](https://github.com/anthropics/claude-code/tree/main/mods)
and changes terminal presentation:

- Bold user prompts with fx/Gent's `┃` rail, on the terminal's own background.
- Assistant replies without the opening bullet, with native markdown, links,
  tables and syntax highlighting.
- Compact shell, search, file and agent activity with working-directory-relative
  paths and actual diff counts.
- A separate per-call inspection pane with output, diff, arguments and captured
  result; large outputs and the activity chooser are paged.
- Plain working verbs, shared transcript alignment and compact turn durations.
- A quiet composer footer: model and context beneath Claude's native controls.
  Account, folder, Git, cost and quotas are available on demand.

See [DESIGN.md](DESIGN.md) for the visual system distilled from fx's source.
All colors use Claude's default tokens.

Click an activity marker to inspect that call, or run `/fx-tool` to choose from
rendered activity. `/fx-tool <tool-id>` opens a known call directly. Switch
sections with Tab/Enter. If the pane does not have keyboard focus, press
Ctrl+X, then Tab to focus it using Claude's native pane controls.
Next/Previous page large output; Copy section copies
its complete source. Escape closes the pane. Click footer `details` or run
`/fx-status` for session and Git figures.

Run `/fx-details [on|off]` to toggle full native tool rows. Claude's mod API does
not expose Ctrl+O detail state on standalone tool rows; Ctrl+O retains Claude's
transcript behavior, while `/fx-tool` and `/fx-details` provide explicit mod
inspection controls.

Errors, interruptions, staged changes, user-modified writes, incomplete and
nontext reads, background commands and safety hints retain native detail.
Permission dialogs, sender labels and remote surfaces remain native. The input
editor and startup logo have no render hook. The mod does not change tool
execution, permissions or stored conversation content.

## Install

The shared `claude/settings.json` loads the mod for both accounts on every
machine: its `env.CLAUDE_CODE_PLUGIN_DIRS` names this folder, and the session
watches it, so a saved edit reloads. Start a new Claude session.

```sh
~/Developer/personal/dotfiles/claude/mods/fx-ui/install.sh
```

The installer (run by the root `install.sh` and `workbox/bootstrap.sh`) removes
the legacy `statusline-git.sh` command from settings, saving that setting in
`.fx-ui-statusline.json`. Shared settings symlinks and custom statusline
commands are preserved. The legacy script remains available.

Usage figures come from Claude's native session API. Missing context readings
stay unknown. Git runs only when status inspection is requested, with a short
timeout; failure leaves the session figures available. Footer text truncates at
narrow widths using the native renderer.

To restore the legacy statusline, remove this folder from
`CLAUDE_CODE_PLUGIN_DIRS` in `claude/settings.json` and run:

```sh
~/Developer/personal/dotfiles/claude/mods/fx-ui/install.sh --restore-statusline
```

Preview an isolated session:

```sh
claude --plugin-dir ~/Developer/personal/dotfiles/claude/mods/fx-ui
```

To preview a saved conversation without editing the original, add
`--resume <session-id> --fork-session`. For the second account, prefix the
command with `CLAUDE_CONFIG_DIR="$HOME/.claude2"`.

## Compatibility and checks

Verified on Claude Code 2.1.295. Anthropic's mod API is early access: function
hooks must be available on the account, and the API may change with updates.
An account without function hooks keeps Claude's native UI.

```sh
claude plugin validate ~/Developer/personal/dotfiles/claude/mods/fx-ui
claude plugin test ~/Developer/personal/dotfiles/claude/mods/fx-ui
sh ~/Developer/personal/dotfiles/claude/mods/fx-ui/tests/install.test.sh
```

Claude generates `.claude-plugin/types/` from the installed engine when the
plugin is loaded explicitly with `--plugin-dir` (the preview command above).
Those declarations are ignored by Git. After that preview, use an installed
TypeScript compiler to check the hooks and tests:

```sh
tsc --noEmit -p ~/Developer/personal/dotfiles/claude/mods/fx-ui/tsconfig.json
```

Markdown leaves have a 10,000-character limit in the mod API. Longer replies
and prompts fall back to the native renderer to preserve the full content.
