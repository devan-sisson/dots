# source ~/.op/plugins.sh 2>/dev/null
# https://github.com/keybase/keybase-issues/issues/1712#issuecomment-141226705
export GPG_TTY=$(tty)

# Undo path_helper's reordering: put .zshenv's PATH back in front (first copy wins).
if [ -n "$_dots_zshenv_path" ]; then
  typeset -U path
  path=(${(s.:.)_dots_zshenv_path} $path)
  unset _dots_zshenv_path
fi

# set PATH so it includes user's private bin if it exists
if [ -d "$HOME/bin" ]; then
  PATH="$HOME/bin:$PATH"
fi

[ -s "$HOME/.cache/dot-brew/summary.txt" ] && cat "$HOME/.cache/dot-brew/summary.txt"

autoload -U add-zsh-hook

fpath=(/usr/local/share/zsh-completions $fpath)

case $(uname) in
Darwin)
  export PATH=/opt/whalebrew/bin:$PATH
  # Nudge a throttled, formula-only brew upgrade in the background on each new
  # session. brew-update self-throttles (1/day) and locks, so firing often is
  # cheap. Casks are left to the 18:00 launchd agent, which asks first.
  [ -x "$HOME/bin/brew-update" ] &&
    ("$HOME/bin/brew-update" --no-casks </dev/null >>"$HOME/.cache/dot-brew/upgrade.log" 2>&1 &)
  ;;
esac

[ -f "$HOME/.zprofile.local" ] && source "$HOME/.zprofile.local"
