#!/bin/bash
set -e

DOTFILES_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing dotfiles from $DOTFILES_DIR"

# Create symlinks
ln -sf "$DOTFILES_DIR/zshrc" ~/.zshrc
ln -sf "$DOTFILES_DIR/gitconfig" ~/.gitconfig
ln -sf "$DOTFILES_DIR/gitignore_global" ~/.gitignore_global

# Ghostty
mkdir -p ~/Library/Application\ Support/com.mitchellh.ghostty
ln -sf "$DOTFILES_DIR/ghostty/config" ~/Library/Application\ Support/com.mitchellh.ghostty/config

# Atuin
mkdir -p ~/.config/atuin
ln -sf "$DOTFILES_DIR/atuin.toml" ~/.config/atuin/config.toml

# Neovim
mkdir -p ~/.config
rm -rf ~/.config/nvim
ln -sf "$DOTFILES_DIR/nvim" ~/.config/nvim

# Lazygit
mkdir -p ~/.config/lazygit
ln -sf "$DOTFILES_DIR/lazygit.yml" ~/.config/lazygit/config.yml

echo "Done! Run 'source ~/.zshrc' to reload."
