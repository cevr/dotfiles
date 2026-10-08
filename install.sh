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

# Pure prompt (vendored)
mkdir -p ~/.zsh
rm -rf ~/.zsh/pure
ln -sf "$DOTFILES_DIR/pure" ~/.zsh/pure

# Lazygit
mkdir -p ~/.config/lazygit
ln -sf "$DOTFILES_DIR/lazygit.yml" ~/.config/lazygit/config.yml

# Herdr (same config and plugins as the workbox)
mkdir -p ~/.config/herdr
ln -sf "$DOTFILES_DIR/workbox/herdr-config.toml" ~/.config/herdr/config.toml
if command -v herdr >/dev/null 2>&1; then
  while IFS=' ' read -r source ref; do
    [ -n "$source" ] || continue
    if [ -n "$ref" ]; then
      herdr plugin install "$source" --ref "$ref" --yes
    else
      herdr plugin install "$source" --yes
    fi
  done < "$DOTFILES_DIR/workbox/herdr-plugins.txt"
fi

# Claude terminal mod (both accounts)
"$DOTFILES_DIR/skills/fx-ui/install.sh"

# Personal commands
mkdir -p ~/.local/bin
ln -sf "$DOTFILES_DIR/skills/track-work-hours/scripts/hours" ~/.local/bin/hours

echo "Done! Run 'source ~/.zshrc' to reload."
