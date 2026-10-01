#!/usr/bin/env bash
# Keeps the shell in step with the git worktree Claude Code is working in.
#   1. A linked worktree gets added to zoxide, so `z <worktree-name>` jumps to it.
#   2. The worktree is recorded in ~/.cache/claude-worktree-cwd/<main repo path, / -> %>/<claude pid>
#      (one file per session, holding the worktree path). A new zsh that starts in the
#      main repo root cd's into the newest record whose claude process is alive (see
#      ~/.zshrc). Leaving the worktree deletes that session's record.
# Runs on SessionStart, CwdChanged, and PostToolUse(EnterWorktree|ExitWorktree).

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

input=$(cat)
dir=$(jq -r '.new_cwd // .cwd // empty' <<<"$input" 2>/dev/null)
[ -n "$dir" ] && [ -d "$dir" ] || exit 0

top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
git_dir=$(git -C "$dir" rev-parse --absolute-git-dir 2>/dev/null)
common_dir=$(cd "$dir" && cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
[ -n "$git_dir" ] && [ -n "$common_dir" ] || exit 0
main_root=$(dirname "$common_dir")

# The claude process is the nearest ancestor that owns a tty (hooks have none).
pid=$$
claude_pid=""
for _ in $(seq 1 10); do
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$pid" ] && [ "$pid" -gt 1 ] || break
  t=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')
  if [ -n "$t" ] && [ "$t" != "??" ]; then
    claude_pid=$pid
    break
  fi
done

state_dir="$HOME/.cache/claude-worktree-cwd/${main_root//\//%}"
# Pre-per-session format was a single file at this path.
[ -f "$state_dir" ] && rm -f "$state_dir"

if [ "$git_dir" != "$common_dir" ]; then
  command -v zoxide >/dev/null && zoxide add "$top"
  if [ -n "$claude_pid" ]; then
    mkdir -p "$state_dir"
    printf '%s\n' "$top" >"$state_dir/$claude_pid"
  fi
elif [ -n "$claude_pid" ]; then
  rm -f "$state_dir/$claude_pid"
fi
exit 0
