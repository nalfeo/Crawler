#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
PROVIDER="${CODEX_PROVIDER:-codex}"
PROMPT_PATH="${CODEX_PROMPT_PATH:-$WORKSPACE/.github/scripts/codex/runtime/prompt.md}"

if [[ ! -f "$PROMPT_PATH" ]]; then
  echo "Prompt file not found: $PROMPT_PATH" >&2
  exit 1
fi

case "$PROVIDER" in
  codex)
    bash "$WORKSPACE/.github/scripts/codex/providers/codex.sh" "$PROMPT_PATH"
    ;;
  *)
    echo "Unknown provider '$PROVIDER'. Set CODEX_PROVIDER=codex or add a provider script." >&2
    exit 1
    ;;
esac
