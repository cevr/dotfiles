# dotfiles

My personal dotfiles.

## Contents

| File | Description |
|------|-------------|
| `zshrc` | Zsh configuration |
| `zshenv` | Laptop PATH setup, including the Claude launcher |
| `workbox/` | Reproducible Bite workbox configuration and services |
| `mac/developer-volume/` | Moves `~/Developer` onto its own APFS volume with no Spotlight and no FSEvents log |
| `gitconfig` | Git configuration |
| `gitignore_global` | Global gitignore |
| `ghostty/config` | Ghostty terminal config |
| `atuin.toml` | Atuin shell history config |
| `claude/` | TeamClaude launcher and shared Claude Code settings and mods |
| `skills/track-work-hours` | `hours` command and agent skill for payroll tracking |

## Installation

```bash
# Clone
git clone git@github.com:cevr/dotfiles.git ~/Developer/personal/dotfiles
cd ~/Developer/personal/dotfiles

# Symlink (run install.sh or manually)
ln -sf $(pwd)/zshenv ~/.zshenv
ln -sf $(pwd)/zshrc ~/.zshrc
ln -sf $(pwd)/gitconfig ~/.gitconfig
ln -sf $(pwd)/gitignore_global ~/.gitignore_global
ln -sf $(pwd)/ghostty/config ~/Library/Application\ Support/com.mitchellh.ghostty/config
ln -sf $(pwd)/atuin.toml ~/.config/atuin/config.toml
mkdir -p ~/.local/bin
ln -sf $(pwd)/skills/track-work-hours/scripts/hours ~/.local/bin/hours
```

### Bite workbox

```bash
~/Developer/personal/dotfiles/workbox/bootstrap.sh
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
