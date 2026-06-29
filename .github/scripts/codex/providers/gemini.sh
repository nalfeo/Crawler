#!/usr/bin/env bash
set -euo pipefail

PROMPT_PATH="${1:?prompt path required}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
RESULT_PATH="${CODEX_RESULT_PATH:-$WORKSPACE/.github/scripts/codex/runtime/codex-result.json}"
MODEL="${CODEX_MODEL:-}"
GEMINI_BIN="${CODEX_BIN:-gemini}"

if ! command -v "$GEMINI_BIN" >/dev/null 2>&1; then
  echo "Gemini CLI not found ('$GEMINI_BIN'). Install @google/gemini-cli or set CODEX_BIN." >&2
  exit 1
fi

mkdir -p "$(dirname "$RESULT_PATH")"

# Override this entirely with CODEX_EXEC_COMMAND when needed.
if [[ -n "${CODEX_EXEC_COMMAND:-}" ]]; then
  echo "Running custom Gemini command"
  bash -lc "$CODEX_EXEC_COMMAND"
else
  if [[ -z "${GEMINI_API_KEY:-}" ]] && [[ ! -f "$HOME/.gemini/oauth_creds.json" ]]; then
    echo "Gemini is not authenticated. Set GEMINI_API_KEY or run 'gemini' once to log in." >&2
    exit 1
  fi
  # --yolo auto-approves tool calls for unattended runs; model is only passed
  # when explicitly configured. The prompt is supplied via -p (non-interactive).
  EXEC_ARGS=(--yolo)
  if [[ -n "$MODEL" ]]; then
    EXEC_ARGS+=(--model "$MODEL")
  fi
  "$GEMINI_BIN" "${EXEC_ARGS[@]}" -p "$(cat "$PROMPT_PATH")"
fi

if [[ ! -f "$RESULT_PATH" ]]; then
  cat > "$RESULT_PATH" <<'JSON'
{
  "summary": "Gemini run completed but did not emit codex-result.json.",
  "work_attempted": [],
  "validation_commands": [],
  "validation_results": [],
  "unresolved_blockers": ["No codex-result.json produced by provider"],
  "thread_responses": []
}
JSON
fi
