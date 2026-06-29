#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
cd "$WORKSPACE"

if [[ -z "$(git status --porcelain)" ]]; then
  echo "changed=false" >> "$GITHUB_OUTPUT"
  echo "files=" >> "$GITHUB_OUTPUT"
  exit 0
fi

files=$(git status --porcelain | awk '{print $2}' | paste -sd ',' -)

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add -A
git commit -m "codex: repair PR automation"
git push origin "HEAD:${PR_BRANCH}"

echo "changed=true" >> "$GITHUB_OUTPUT"
echo "files=$files" >> "$GITHUB_OUTPUT"
