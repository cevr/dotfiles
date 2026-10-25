#!/bin/bash
set -e

DOTFILES_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing dotfiles from $DOTFILES_DIR"

# Create symlinks
ln -sfn "$DOTFILES_DIR/zshenv" ~/.zshenv
ln -sf "$DOTFILES_DIR/zshrc" ~/.zshrc
ln -sf "$DOTFILES_DIR/gitconfig" ~/.gitconfig
ln -sf "$DOTFILES_DIR/gitignore_global" ~/.gitignore_global

# Ghostty
mkdir -p ~/Library/Application\ Support/com.mitchellh.ghostty
ln -sf "$DOTFILES_DIR/ghostty/config" ~/Library/Application\ Support/com.mitchellh.ghostty/config

# Weekly jobs
mkdir -p ~/Library/LaunchAgents
for plist in "$DOTFILES_DIR"/mac/launchd/*.plist; do
  label=$(basename "$plist" .plist)
  ln -sf "$plist" ~/Library/LaunchAgents/
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/"$label".plist
done

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

# Claude settings (TeamClaude manages the account pool)
mkdir -p ~/.claude ~/.config
ln -sfn "$DOTFILES_DIR/claude/settings.json" ~/.claude/settings.json
ln -sfn "$DOTFILES_DIR/agents" ~/.claude/agents
"$DOTFILES_DIR/claude/install-herdr-hook.sh"

# Orchestrate budget settings (shared with the workbox)
mkdir -p ~/.config/orchestrate
ln -sfn "$DOTFILES_DIR/orchestrate/budget.json" ~/.config/orchestrate/budget.json

# Codex config (shared with the workbox; it writes through the link)
mkdir -p ~/.codex
ln -sfn "$DOTFILES_DIR/codex/config.toml" ~/.codex/config.toml
ln -sfn "$DOTFILES_DIR/codex/agents" ~/.codex/agents

# Claude terminal mod
"$DOTFILES_DIR/claude/mods/fx-ui/install.sh"

# Personal commands
mkdir -p ~/.local/bin
ln -sf "$DOTFILES_DIR/skills/track-work-hours/scripts/hours" ~/.local/bin/hours
# The daemon the codex mod drives Codex threads through.
ln -sf "$DOTFILES_DIR/claude/mods/codex/bridge/bridge.ts" ~/.local/bin/codex-bridge

echo "Done! Run 'source ~/.zshrc' to reload."
