#!/usr/bin/env bash
set -euo pipefail

PROMPT_PATH="${1:?prompt path required}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
RESULT_PATH="${CODEX_RESULT_PATH:-$WORKSPACE/.github/scripts/codex/runtime/codex-result.json}"
MODEL="${CODEX_MODEL:-gpt-5.5}"
CODEX_BIN="${CODEX_BIN:-codex}"

if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
  echo "Codex CLI not found ('$CODEX_BIN'). Install it or set CODEX_BIN to an available CLI." >&2
  exit 1
fi

mkdir -p "$(dirname "$RESULT_PATH")"

# Override this entirely with CODEX_EXEC_COMMAND when needed.
if [[ -n "${CODEX_EXEC_COMMAND:-}" ]]; then
  echo "Running custom Codex command"
  bash -lc "$CODEX_EXEC_COMMAND"
else
  PROMPT_CONTENT="$(cat "$PROMPT_PATH")"
  "$CODEX_BIN" exec --non-interactive --model "$MODEL" "$PROMPT_CONTENT"
fi

if [[ ! -f "$RESULT_PATH" ]]; then
  cat > "$RESULT_PATH" <<'JSON'
{
  "summary": "Codex run completed but did not emit codex-result.json.",
  "work_attempted": [],
  "validation_commands": [],
  "validation_results": [],
  "unresolved_blockers": ["No codex-result.json produced by provider"],
  "thread_responses": []
}
JSON
fi
