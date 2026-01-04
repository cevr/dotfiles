# dotfiles

My personal dotfiles.

## Contents

| File | Description |
|------|-------------|
| `zshrc` | Zsh configuration |
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

## Brew packages

```bash
brew install aws-vault fzf fd eza zsh-completions trash lazygit bat git-delta ripgrep
```
