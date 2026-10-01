### Zinit bootstrap
ZINIT_HOME="$HOME/.local/share/zinit/zinit.git"
if [[ ! -f "$ZINIT_HOME/zinit.zsh" ]]; then
  print -P "%F{33}Installing zinit...%f"
  command mkdir -p "$(dirname "$ZINIT_HOME")" && command chmod g-rwX "$(dirname "$ZINIT_HOME")"
  command git clone https://github.com/zdharma-continuum/zinit "$ZINIT_HOME"
fi
source "$ZINIT_HOME/zinit.zsh"
autoload -Uz _zinit
(( ${+_comps} )) && _comps[zinit]=_zinit

# command-not-found (pkgfile on Arch, Homebrew's handler elsewhere) comes from
# the OMZP::command-not-found snippet below.
if [[ $(uname) == Darwin ]]; then
  test -e "${HOME}/.iterm2_shell_integration.zsh" && source "${HOME}/.iterm2_shell_integration.zsh"
fi
# rbenv is installed on macOS (Brewfile) and Arch (packages/pacman.txt).
command -v rbenv >/dev/null && eval "$(rbenv init - zsh)"

autoload -U colors && colors
autoload -Uz compinit && compinit
autoload -U +X bashcompinit && bashcompinit
autoload -Uz add-zsh-hook

# who cares about casing? I don't
zstyle ':completion:*' matcher-list 'm:{a-zA-Z}={A-Za-z}'

eval "$(zoxide init zsh)"

# `z <partial><Tab>` offers the last path segment of every zoxide entry
# (e.g. worktree names) alongside local directories.
# Wraps zoxide's completion so `z foo <Space><Tab>` still opens its picker.
_z_complete_names() {
  __zoxide_z_complete
  (( CURRENT == 2 && CURRENT == ${#words} )) || return
  local -a names
  names=(${(u)${(f)"$(zoxide query -l 2>/dev/null)"}:t})
  compadd -J zoxide -X '%Bzoxide%b' -a names
}
compdef _z_complete_names z

# A new shell that opens in a repo root follows a live Claude Code session into its
# worktree. Written by ~/.claude/hooks/worktree-terminal-sync.sh, keyed by the
# physical path. Skipped for `zsh -ic cmd` so scripted commands stay put.
() {
  [[ -z $ZSH_EXECUTION_STRING ]] || return
  local d=~/.cache/claude-worktree-cwd/${${PWD:A}//\//%} f wt
  [[ -d $d ]] || return
  # One record per session, named by claude pid; newest live one wins.
  for f in $d/*(N.om); do
    wt=$(<$f)
    if kill -0 ${f:t} 2>/dev/null && [[ -d $wt ]]; then
      cd -- $wt
      return
    fi
    rm -f -- $f
  done
}

# OMZ libraries that the plugins/keybindings below depend on.
zinit snippet OMZL::git.zsh
zinit snippet OMZL::key-bindings.zsh

# OMZ plugins
zinit snippet OMZP::git
zinit snippet OMZP::gh
zinit snippet OMZP::sudo
zinit snippet OMZP::colored-man-pages
zinit snippet OMZP::command-not-found
zinit snippet OMZP::docker-compose
zinit snippet OMZP::kubectl
zinit snippet OMZP::aws
zinit snippet OMZP::extract

# External plugins. fzf-tab must load before autosuggestions/syntax-highlighting;
# fast-syntax-highlighting must load last.
zinit light akoenig/npm-run.plugin.zsh
zinit light supercrabtree/k
zinit light Aloxaf/fzf-tab
zinit light MichaelAquilina/zsh-you-should-use
zinit light zsh-users/zsh-autosuggestions
zinit light zsh-users/zsh-history-substring-search
zinit light zdharma-continuum/fast-syntax-highlighting

# Make fast-syntax-highlighting color known commands like zsh-syntax-highlighting does.
FAST_HIGHLIGHT_STYLES[command]=fg=green
FAST_HIGHLIGHT_STYLES[builtin]=fg=green
FAST_HIGHLIGHT_STYLES[function]=fg=green
FAST_HIGHLIGHT_STYLES[alias]=fg=green
FAST_HIGHLIGHT_STYLES[precommand]=fg=green,underline
FAST_HIGHLIGHT_STYLES[unknown-token]=fg=red,bold

HISTFILE=~/.zsh_history
HISTSIZE=100000
SAVEHIST=100000
setopt SHARE_HISTORY       # global: all sessions share one history, live (implies incremental append)
setopt EXTENDED_HISTORY    # record timestamps
setopt HIST_FIND_NO_DUPS
setopt HIST_IGNORE_DUPS
setopt AUTO_CD             # bare paths like ../../ cd instead of trying to exec

source <(fzf --zsh)
eval "$(atuin init zsh --disable-up-arrow)" # atuin owns ctrl-r; up-arrow stays native zsh
eval "$(starship init zsh)"

# Inline, prefix-filtered history cycling on up/down (no menu, single Enter to run).
# Must come after atuin init so it isn't overridden.
bindkey '^[[A' history-substring-search-up
bindkey '^[[B' history-substring-search-down
# OMZL::key-bindings enables application mode (smkx), where arrows send ^[OA/^[OB.
[[ -n ${terminfo[kcuu1]} ]] && bindkey "${terminfo[kcuu1]}" history-substring-search-up
[[ -n ${terminfo[kcud1]} ]] && bindkey "${terminfo[kcud1]}" history-substring-search-down

# source ~/.config/op/plugins.sh
source ~/.aliases

# rbenv/ruby-build openssl hint (macOS/Ubuntu-brew only; Arch finds it natively).
if [ -n "$HOMEBREW_PREFIX" ]; then
  export RUBY_CONFIGURE_OPTS="--with-openssl-dir=$HOMEBREW_PREFIX/opt/openssl@3"
fi

# [ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# proto
export PROTO_HOME="$HOME/.proto";
export PATH="$PROTO_HOME/shims:$PROTO_HOME/bin:$PATH";

# Added by GitButler installer
export PATH="$HOME/.local/bin:$PATH"
command -v but >/dev/null && eval "$(but completions zsh)"

aws_auto_profile_hook() {
  local file profile
  file=$(upfind .aws-profile)

  if [[ -z "$file" ]]; then
    # Only clear a profile this hook set; leave a manually exported one alone.
    [[ -n "$_aws_auto_profile" && "$AWS_PROFILE" == "$_aws_auto_profile" ]] && unset AWS_PROFILE
    unset _aws_auto_profile
    return
  fi

  profile=$(cat "$file")

  [[ -z "$profile" ]] && echo -e ".aws-profile was empty.\nNo profile found $file" && return

  if [[ "$AWS_PROFILE" != "$profile" ]]; then
    echo "AWS_PROFILE changing from '${AWS_PROFILE:-unset}' to '$profile'"
  fi

  export AWS_PROFILE="$profile"
  _aws_auto_profile="$profile"
}

add-zsh-hook chpwd aws_auto_profile_hook &&
  aws_auto_profile_hook

command -v conda >/dev/null && eval "$(conda shell.zsh hook)"

[ -f "$HOME/.zshrc.local" ] && source "$HOME/.zshrc.local"
