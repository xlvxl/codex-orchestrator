#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
target_dir=/home/vscode/.local/bin

if [ "${1-}" = "--target-dir" ] && [ -n "${2-}" ] && [ "$#" -eq 2 ]; then
  target_dir=$2
elif [ "$#" -ne 0 ]; then
  printf '%s\n' 'usage: install-subscription-workers.sh [--target-dir DIR]' >&2
  exit 64
fi

mkdir -p "$target_dir"
for launcher in \
  llm-agent-env-sanitizer \
  subscription-policy.sh \
  claude-subscription-worker \
  codex-subscription-worker; do
  install -m 0755 "$script_dir/$launcher" "$target_dir/$launcher"
done

printf 'Installed subscription launchers in %s\n' "$target_dir"
