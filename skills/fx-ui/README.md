# fx-ui

A Claude Code render mod inspired by [fx](https://github.com/vercel-labs/fx) and
[Gent](https://github.com/cevr/gent). It uses Claude's
[function-hook mod API](https://github.com/anthropics/claude-code/tree/main/mods)
and changes terminal presentation:

- Bold user prompts with fx/Gent's `┃` rail, on the terminal's own background.
- Assistant replies without the opening bullet, with native markdown, links,
  tables and syntax highlighting.
- Muted tool groups (`● 5 tool calls · 3 read · 2 command`), with explicit failures and interruptions.
- File-path rows for standalone reads, writes and edits; successful text bodies
  and diffs stay collapsed. Writes show the saved line count.
- Plain working verbs and compact turn durations.
- A muted composer footer: model, account/folder, Git branch and changed-file
  count, context, session cost, and available usage windows. Native input and
  permission controls stay live above it.

Run `/fx-details` to toggle all tool rows between compact and full native
arguments/output, or `/fx-details on` and `/fx-details off` to choose explicitly.
The mode lasts for the session. Claude's mod API does not expose the Ctrl+O
detail state on standalone tool rows, so use `/fx-details on` to inspect them;
Ctrl+O still opens Claude's transcript view.

Errors, interruptions, staged changes, user-modified writes, paginated reads,
nontext read results, other standalone tools, permission dialogs, sender
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
It also removes the legacy `statusline-git.sh` command from settings, saving
that setting in `.fx-ui-statusline.json`. Shared settings symlinks and custom
statusline commands are preserved. The legacy script remains available.

Usage figures come from Claude's native session API; no credential lookup or
background HTTP polling is needed. Unavailable readings are omitted, and
context stays unknown until Claude has a reading. Git metadata refreshes on
footer redraws, cached for two seconds. Narrow terminals split identity and
usage into two rows, truncating only a row that still does not fit.

To restore the legacy statusline, disable `fx-ui` and run:

```sh
~/Developer/personal/dotfiles/skills/fx-ui/install.sh --restore-statusline
```

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
sh ~/Developer/personal/dotfiles/skills/fx-ui/tests/install.test.sh
```

Claude generates `.claude-plugin/types/` from the installed engine when the
plugin is loaded explicitly with `--plugin-dir` (the preview command above).
Those declarations are ignored by Git. After that preview, use an installed
TypeScript compiler to check the hooks and tests:

```sh
tsc --noEmit -p ~/Developer/personal/dotfiles/skills/fx-ui/tsconfig.json
```

Markdown leaves have a 10,000-character limit in the mod API. Longer replies
and prompts fall back to the native renderer to preserve the full content.
