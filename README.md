# dotfiles

My personal dotfiles.

## Contents

| File | Description |
|------|-------------|
| `zshrc` | Zsh configuration |
| `workbox/` | Reproducible Bite workbox configuration and services |
| `gitconfig` | Git configuration |
| `gitignore_global` | Global gitignore |
| `ghostty/config` | Ghostty terminal config |
| `atuin.toml` | Atuin shell history config |

## Installation

```bash
# Clone
git clone git@github.com:cevr/dotfiles.git ~/Developer/personal/dotfiles
cd ~/Developer/personal/dotfiles

# Symlink (run install.sh or manually)
ln -sf $(pwd)/zshrc ~/.zshrc
ln -sf $(pwd)/gitconfig ~/.gitconfig
ln -sf $(pwd)/gitignore_global ~/.gitignore_global
ln -sf $(pwd)/ghostty/config ~/Library/Application\ Support/com.mitchellh.ghostty/config
ln -sf $(pwd)/atuin.toml ~/.config/atuin/config.toml
```

### Bite workbox

```bash
~/Developer/personal/dotfiles/workbox/bootstrap.sh
```

## Brew packages

```bash
# Install everything from Brewfile
brew bundle

# Or manually:
brew install aws-vault fzf fd eza zsh-completions trash lazygit bat git-delta ripgrep
```
