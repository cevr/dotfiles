[ -r "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

typeset -U path PATH
path=(
  "$HOME/Developer/personal/dotfiles/claude/bin"
  "$HOME/.local/bin"
  "$HOME/.bun/bin"
  /opt/homebrew/bin
  $path
)
export PATH
