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
# AWS (secure - no hardcoded credentials)
# ===========================================
export AWS_REGION=us-east-1
export CLAUDE_CODE_USE_BEDROCK=1
export ANTHROPIC_MODEL="global.anthropic.claude-opus-4-5-20251101-v1:0"
# Credentials managed via aws-vault or ~/.aws/credentials

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
# NODE VERSION MANAGER (fnm only - fast)
# ===========================================
FNM_PATH="/Users/cvr/Library/Application Support/fnm"
if [ -d "$FNM_PATH" ]; then
  export PATH="$FNM_PATH:$PATH"
  eval "$(fnm env --use-on-cd --shell zsh)"
fi

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
# Interactive "Did you mean?" for typos
command_not_found_handler() {
  local cmd="$1"
  shift
  local args="$@"

  # Find the best matching command (first 3 chars, case-insensitive)
  local suggestion=$(whence -m "${cmd:0:3}*" 2>/dev/null | head -1)

  if [[ -z "$suggestion" ]]; then
    suggestion=$(compgen -c 2>/dev/null | grep -i "^${cmd:0:3}" | head -1)
  fi

  if [[ -n "$suggestion" ]]; then
    echo "zsh: command not found: $cmd"
    printf "Did you mean '\e[1;32m%s\e[0m'? [Y/n] " "$suggestion"
    read -r -k 1 response
    echo
    if [[ "$response" =~ ^[Yy]$ ]] || [[ -z "$response" ]]; then
      "$suggestion" $args
      return $?
    fi
  else
    echo "zsh: command not found: $cmd"
  fi

  return 127
}

# Git default branch detection (main vs master)
git_default_branch() {
  git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "master"
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
  for f in *.HEIC *.heic; do
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

# pnpm shortcuts
alias pi='pnpm i'
alias pid='pnpm i -D'
alias pr='pnpm run'
alias prd='pnpm run dev'
alias prc='pnpm run compile'
alias prt='pnpm run typecheck'
alias prl='pnpm run lint'

# Quick navigation
alias zb='z bite'
alias zbur='z bureau'
alias zvit='z vitrine'
alias zbib='z bible'

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

# Safety nets
alias rm='trash'  # brew install trash - sends to macOS Trash instead of permanent delete
alias mv='mv -i'
alias cp='cp -i'
