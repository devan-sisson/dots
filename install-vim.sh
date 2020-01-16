#!/bin/bash
source $PWD/scripts/helpers.sh

# verify git is installed
command -v git >/dev/null 2>&1 || { echo >&2 "I require git but it's not installed.  Aborting."; exit 1; }

if ! file_exists .vimrc ; then
  link_dot_file vimrc
fi

echo "installing vim"
sh $PWD/scripts/vim.sh
clear
