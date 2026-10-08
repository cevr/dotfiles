# fx-ui

A Claude Code render mod inspired by [fx](https://github.com/vercel-labs/fx) and
[Gent](https://github.com/cevr/gent). It uses Claude's
[function-hook mod API](https://github.com/anthropics/claude-code/tree/main/mods)
and changes terminal presentation:

- Bold user prompts with fx/Gent's `┃` rail, on the terminal's own background.
- Assistant replies without the opening bullet, with native markdown, links,
  tables and syntax highlighting.
- Muted tool groups (`● Read 3 · Shell 2`), with explicit failures and interruptions.
- Plain working verbs and compact turn durations.

Standalone tools, expanded tool groups (`ctrl+o`), permission dialogs, sender
labels, and remote surfaces keep their native rendering. The input editor and
startup logo have no render hook in this API. This mod never changes prompts,
tool execution, permissions, or stored conversation content.

## Install

```sh
~/Developer/personal/dotfiles/skills/fx-ui/install.sh
```

The installer exposes the plugin in both `~/.claude/skills` and
`~/.claude2/skills`, preserving other skills. If those directories already point
to dotfiles, nothing needs linking. Start a new Claude session; the mod loads as
`fx-ui@skills-dir`. `install.sh` and `workbox/bootstrap.sh` include this step.

Preview an isolated session before installing:

```sh
claude --plugin-dir ~/Developer/personal/dotfiles/skills/fx-ui
```

To preview a saved conversation without editing the original, add
`--resume <session-id> --fork-session`. For the second account, prefix the
command with `CLAUDE_CONFIG_DIR="$HOME/.claude2"`.

Disable or enable for either account:

```sh
claude plugin disable fx-ui@skills-dir
claude plugin enable fx-ui@skills-dir
CLAUDE_CONFIG_DIR="$HOME/.claude2" claude plugin disable fx-ui@skills-dir
```

## Compatibility and checks

Verified on Claude Code 2.1.295. Anthropic's mod API is early access: function
hooks must be available on the account, and the API may change with updates.
An account without function hooks keeps Claude's native UI.

```sh
claude plugin validate ~/Developer/personal/dotfiles/skills/fx-ui
claude plugin test ~/Developer/personal/dotfiles/skills/fx-ui
```

Claude generates `.claude-plugin/types/` from the installed engine when the
plugin is loaded explicitly with `--plugin-dir` (the preview command above).
Those declarations are ignored by Git. After that preview, use an installed
TypeScript compiler to check the hooks and tests:

```sh
tsc -p ~/Developer/personal/dotfiles/skills/fx-ui/tsconfig.json
```

Markdown leaves have a 10,000-character limit in the mod API. Longer replies
and prompts fall back to the native renderer to preserve the full content.
