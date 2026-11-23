# dotfiles

My personal dotfiles.

## Contents

| File | Description |
|------|-------------|
| `zshrc` | Zsh configuration |
| `zshenv` | Laptop PATH setup, including the Claude launcher |
| `workbox/` | Reproducible Bite workbox configuration and services |
| `mac/developer-volume/` | Moves `~/Developer` onto its own APFS volume with no Spotlight and no FSEvents log |
| `mac/launchd/` | Mac jobs that `install.sh` loads: the weekly transcript image cull, the daily transcript backup, the weekly upstreams scan and the daily Claude Code install |
| `transcripts/` | R2 archive of Claude and Codex transcripts (Alchemy stack, `archive.ts push`/`pull`, `credentials.ts`) |
| `gitconfig` | Git configuration |
| `gitignore_global` | Global gitignore |
| `ghostty/config` | Ghostty terminal config |
| `atuin.toml` | Atuin shell history config |
| `claude/` | TeamClaude launcher and shared Claude Code settings and mods |
| `opencode/` | OpenCode 2.x mods (Prime Agent look, account pool, orchestrate, code kernel, status), their scenario tests and the gamut live testbed; see `opencode/AGENTS.md` |
| `skills/track-work-hours` | `hours` command and agent skill for payroll tracking |

## Installation

```bash
# Clone
git clone git@github.com:cevr/dotfiles.git ~/Developer/personal/dotfiles
cd ~/Developer/personal/dotfiles

# Symlink (run install.sh or manually)
ln -sf -- "$PWD/zshenv" ~/.zshenv
ln -sf -- "$PWD/zshrc" ~/.zshrc
ln -sf -- "$PWD/gitconfig" ~/.gitconfig
ln -sf -- "$PWD/gitignore_global" ~/.gitignore_global
ln -sf -- "$PWD/ghostty/config" "$HOME/Library/Application Support/com.mitchellh.ghostty/config"
ln -sf -- "$PWD/atuin.toml" ~/.config/atuin/config.toml
mkdir -p ~/.local/bin
ln -sf -- "$PWD/skills/track-work-hours/scripts/hours" ~/.local/bin/hours
```

### Bite workbox

#### Host identity

These commands assume a machine you trust: the check behind this document constrains the commands as written here, not your shell's startup files, the programs those command names resolve to, this checkout, or the local and remote configuration of the tools they use (ssh, git, systemd, rsync).

For the approved deployment, replace the literal
`<machine-id-from-deployment-record>` with the intended workbox ID from the
operator's deployment record opened at order time and confirmed via the provider console.
Reading the ID from whichever machine you are logged into defeats the check.

```bash
# Pin source: workbox deployment record; see [Host identity](#host-identity).
WORKBOX_EXPECT_MACHINE_ID='<machine-id-from-deployment-record>' ~/Developer/personal/dotfiles/workbox/bootstrap.sh
```

### Claude

[`claude/`](claude/README.md) provides the `claude` executable shim for
TeamClaude on the laptop and workbox. Claude Code uses one profile (`~/.claude`)
with shared `settings.json` (symlinked by `install.sh` and the workbox bootstrap)
and the mods under `claude/mods/`, which `settings.json` loads.

## Brew packages

```bash
# Install everything from Brewfile
brew bundle

# Or manually:
brew install aws-vault fzf fd eza zsh-completions trash lazygit bat git-delta ripgrep gogcli jq
```
