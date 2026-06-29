#!/usr/bin/env bash
set -euo pipefail

PROMPT_PATH="${1:?prompt path required}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
RESULT_PATH="${CODEX_RESULT_PATH:-$WORKSPACE/.github/scripts/codex/runtime/codex-result.json}"
MODEL="${CODEX_MODEL:-}"
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
  # Ensure auth: prefer an existing login session; otherwise log in with the API key.
  if ! "$CODEX_BIN" login status >/dev/null 2>&1; then
    if [[ -n "${OPENAI_API_KEY:-}" ]]; then
      printf '%s' "$OPENAI_API_KEY" | "$CODEX_BIN" login --with-api-key
    else
      echo "Codex is not logged in and OPENAI_API_KEY is unset. Run 'codex login' or set OPENAI_API_KEY." >&2
      exit 1
    fi
  fi
  # `codex exec` is inherently non-interactive. Sandbox/approval bypass keeps
  # automation unattended; model is only passed when explicitly configured.
  EXEC_ARGS=(exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox)
  if [[ -n "$MODEL" ]]; then
    EXEC_ARGS+=(--model "$MODEL")
  fi
  "$CODEX_BIN" "${EXEC_ARGS[@]}" - <"$PROMPT_PATH"
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
