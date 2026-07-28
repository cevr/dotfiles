# ===========================================
# PATH & FPATH SETUP
# ===========================================
fpath+=("$(brew --prefix)/share/zsh/site-functions" $HOME/.zsh/pure)

# ===========================================
# OH-MY-ZSH
# ===========================================
export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME=""
plugins=(git z zsh-completions zsh-autosuggestions zsh-syntax-highlighting)
source $ZSH/oh-my-zsh.sh

# ===========================================
# PACKAGE MANAGERS (bun preferred)
# ===========================================
# bun (primary)
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
[ -s "/Users/cvr/.bun/_bun" ] && source "/Users/cvr/.bun/_bun"

# pnpm (keep for legacy projects)
export PNPM_HOME="/Users/cvr/Library/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac

# node_modules local binaries
export PATH="$PATH:./node_modules/.bin"

# ===========================================
# NODE VERSION MANAGER (nvm)
# ===========================================
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Auto-switch node version when entering directory with .nvmrc
autoload -U add-zsh-hook
load-nvmrc() {
  local nvmrc_path="$(nvm_find_nvmrc)"
  if [ -n "$nvmrc_path" ]; then
    local nvmrc_node_version=$(nvm version "$(cat "${nvmrc_path}")")
    if [ "$nvmrc_node_version" = "N/A" ]; then
      nvm install
    elif [ "$nvmrc_node_version" != "$(nvm version)" ]; then
      nvm use
    fi
  elif [ -n "$(PWD=$OLDPWD nvm_find_nvmrc)" ] && [ "$(nvm version)" != "$(nvm version default)" ]; then
    echo "Reverting to nvm default version"
    nvm use default
  fi
}
add-zsh-hook chpwd load-nvmrc
load-nvmrc

# ===========================================
# PROMPT
# ===========================================
autoload -U promptinit; promptinit
prompt pure

# ===========================================
# TOOLS
# ===========================================
# atuin (shell history)
. "$HOME/.atuin/bin/env"
eval "$(atuin init zsh)"

# fzf (fuzzy finder)
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
export FZF_DEFAULT_OPTS='--height 40% --layout=reverse --border'
export FZF_DEFAULT_COMMAND='fd --type f --hidden --exclude .git --exclude node_modules'
export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
export FZF_ALT_C_COMMAND='fd --type d --hidden --exclude .git --exclude node_modules'

# ===========================================
# ADDITIONAL PATH
# ===========================================
export PATH="/opt/homebrew/opt/trash/bin:$PATH"  # trash is keg-only
export PATH=/Users/cvr/.opencode/bin:$PATH
export PATH="$HOME/.local/bin:$PATH"

# ===========================================
# FUNCTIONS
# ===========================================
# Silence shopt warnings (bash compatibility)
shopt() { :; }

# Git default branch detection (main vs master)
git_default_branch() {
  git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "master"
}

# Kill all node processes
knode() {
  killall -9 node 2>/dev/null || echo "No node processes found"
}

# Kill all bun processes
kbun() {
  killall -9 bun 2>/dev/null || echo "No bun processes found"
}

# Fetch and merge origin's version of current branch
gfmo() {
  local branch=$(git branch --show-current)
  git fetch origin && git merge "origin/$branch"
}

# Fetch and merge origin's default branch (main or master)
gfom() {
  local default=$(git_default_branch)
  git fetch origin && git merge "origin/$default"
}

# Create branch with cvr/ prefix
gcvr() {
  git checkout -b "cvr/$1"
}

# Create branch with bite- prefix
gbite() {
  git checkout -b "bite-$1"
}

# Convert all HEIC files in current directory to JPEG
heic2jpg() {
  for f in *.HEIC(N) *.heic(N); do
    [ -e "$f" ] || continue
    sips -s format jpeg "$f" --out "${f%.*}.jpg"
  done
}

# ===========================================
# ALIASES
# ===========================================
# Navigation
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'

# ls improvements
if command -v eza &> /dev/null; then
  alias ls='eza'
  alias ll='eza -la --git'
  alias tree='eza --tree'
else
  alias ll='ls -la'
fi

# Git
alias glog='git log --oneline --graph --decorate -10'
alias gcb='git checkout -b'
alias gcB='git checkout -B'
alias gcom='git checkout master'
alias gcod='git checkout develop'
alias lg='lazygit'

# fd (find replacement) - ignore node_modules/git by default
alias f='fd --hidden --exclude node_modules --exclude .git'

# bat (cat replacement with syntax highlighting)
alias cat='bat --paging=never'
alias catp='bat'  # with paging

# Quick edits
alias zshrc='${EDITOR:-code} ~/.zshrc'
alias reload='source ~/.zshrc'

# Development (bun preferred)
alias b='bun'
alias bi='bun install'
alias br='bun run'
alias bd='bun dev'
alias bx='bunx'

# Bite workbox
workbox-sideshow() {
  open https://bite-cristian.exe.xyz:8228/
}

workbox() {
  workbox-sideshow || return
  herdr --remote bite-workbox --session bite
}

# Safety nets
alias rm='trash'  # brew install trash - sends to macOS Trash instead of permanent delete
alias mv='mv -i'
alias cp='cp -i'

# The next line updates PATH for the Google Cloud SDK.
if [ -f '/Users/cvr/Downloads/google-cloud-sdk/path.zsh.inc' ]; then . '/Users/cvr/Downloads/google-cloud-sdk/path.zsh.inc'; fi

# The next line enables shell command completion for gcloud.
if [ -f '/Users/cvr/Downloads/google-cloud-sdk/completion.zsh.inc' ]; then . '/Users/cvr/Downloads/google-cloud-sdk/completion.zsh.inc'; fi

# Second Claude Code account (separate config/session)
alias claude2='CLAUDE_CONFIG_DIR=~/.claude2 /Users/cvr/.local/bin/claude'
