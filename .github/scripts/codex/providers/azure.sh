#!/usr/bin/env bash
set -euo pipefail

PROMPT_PATH="${1:?prompt path required}"
WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
RESULT_PATH="${CODEX_RESULT_PATH:-$WORKSPACE/.github/scripts/codex/runtime/codex-result.json}"
CODEX_BIN="${CODEX_BIN:-codex}"
# For Azure, CODEX_MODEL is the *deployment* name (not the base model id). Azure
# has no implicit default deployment, so fall back to a common one.
MODEL="${CODEX_MODEL:-gpt-4o}"
ENDPOINT="${AZURE_OPENAI_ENDPOINT:-}"
API_VERSION="${AZURE_OPENAI_API_VERSION:-2025-04-01-preview}"

if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
  echo "Codex CLI not found ('$CODEX_BIN'). Install @openai/codex or set CODEX_BIN." >&2
  exit 1
fi

if [[ -z "$ENDPOINT" ]]; then
  echo "AZURE_OPENAI_ENDPOINT is required (e.g. https://<resource>.openai.azure.com)." >&2
  exit 1
fi
ENDPOINT="${ENDPOINT%/}"
BASE_URL="$ENDPOINT/openai"

# Auth: prefer an explicit key. Otherwise, if `az` is logged in and the resource
# coordinates are provided, fetch the key at runtime so no secret has to be
# stored (keyless-from-the-operator's-view local runs via `az login`).
if [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]; then
  if command -v az >/dev/null 2>&1 && [[ -n "${AZURE_OPENAI_RESOURCE:-}" && -n "${AZURE_OPENAI_RESOURCE_GROUP:-}" ]]; then
    echo "AZURE_OPENAI_API_KEY unset; fetching key via az for '$AZURE_OPENAI_RESOURCE'..." >&2
    AZURE_OPENAI_API_KEY="$(az cognitiveservices account keys list \
      -n "$AZURE_OPENAI_RESOURCE" -g "$AZURE_OPENAI_RESOURCE_GROUP" --query key1 -o tsv)"
  fi
fi
if [[ -z "${AZURE_OPENAI_API_KEY:-}" ]]; then
  echo "Azure auth missing. Set AZURE_OPENAI_API_KEY, or set AZURE_OPENAI_RESOURCE + AZURE_OPENAI_RESOURCE_GROUP with an active 'az login'." >&2
  exit 1
fi
export AZURE_OPENAI_API_KEY

mkdir -p "$(dirname "$RESULT_PATH")"

# Override this entirely with CODEX_EXEC_COMMAND when needed.
if [[ -n "${CODEX_EXEC_COMMAND:-}" ]]; then
  echo "Running custom Codex (Azure) command"
  bash -lc "$CODEX_EXEC_COMMAND"
else
  # Codex talks to Azure OpenAI through a custom model provider that points at
  # the deployment's Responses API. `env_key` makes Codex read the key from the
  # environment, so no `codex login` is required for this provider.
  EXEC_ARGS=(
    exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox
    -c model_provider=azure
    -c model_providers.azure.name=Azure
    -c "model_providers.azure.base_url=$BASE_URL"
    -c model_providers.azure.env_key=AZURE_OPENAI_API_KEY
    -c "model_providers.azure.query_params.api-version=$API_VERSION"
    -c model_providers.azure.wire_api=responses
    --model "$MODEL"
  )
  "$CODEX_BIN" "${EXEC_ARGS[@]}" - <"$PROMPT_PATH"
fi

if [[ ! -f "$RESULT_PATH" ]]; then
  cat > "$RESULT_PATH" <<'JSON'
{
  "summary": "Codex (Azure) run completed but did not emit codex-result.json.",
  "work_attempted": [],
  "validation_commands": [],
  "validation_results": [],
  "unresolved_blockers": ["No codex-result.json produced by provider"],
  "thread_responses": []
}
JSON
fi
