#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Run the codex-repair pipeline locally against a synced PR branch.

Usage:
  scripts/codex-repair-local.sh --pr <number> [options]

Options:
  --pr <number>            Pull request number (required)
  --env-file <path>        Env file to source (default: .env.codex.local)
  --checkout               Run `gh pr checkout <number>` before execution
  --mode <value>           REPAIR_MODE value (default: manual)
  --trigger <value>        REPAIR_TRIGGER value (default: local)
  --command <value>        REPAIR_COMMAND value (default: /codex fix ci)
  --explicit <bool>        IS_EXPLICIT_COMMAND value (default: true)
  --install-codex          Install @openai/codex globally before run
  -h, --help               Show help
EOF
}

PR_NUMBER=''
ENV_FILE='.env.codex.local'
CHECKOUT_PR='false'
REPAIR_MODE='manual'
REPAIR_TRIGGER='local'
REPAIR_COMMAND='/codex fix ci'
IS_EXPLICIT_COMMAND='true'
INSTALL_CODEX='false'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)
      PR_NUMBER="${2:-}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      shift 2
      ;;
    --checkout)
      CHECKOUT_PR='true'
      shift
      ;;
    --mode)
      REPAIR_MODE="${2:-}"
      shift 2
      ;;
    --trigger)
      REPAIR_TRIGGER="${2:-}"
      shift 2
      ;;
    --command)
      REPAIR_COMMAND="${2:-}"
      shift 2
      ;;
    --explicit)
      IS_EXPLICIT_COMMAND="${2:-}"
      shift 2
      ;;
    --install-codex)
      INSTALL_CODEX='true'
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PR_NUMBER" ]]; then
  echo "--pr is required." >&2
  usage >&2
  exit 1
fi

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
cd "$WORKSPACE"

if [[ -f "$ENV_FILE" ]]; then
  echo "Loading env from $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
  GITHUB_REPOSITORY="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
  export GITHUB_REPOSITORY
fi
export GITHUB_WORKSPACE="$WORKSPACE"

if [[ "$CHECKOUT_PR" == 'true' ]]; then
  gh pr checkout "$PR_NUMBER"
fi

if [[ "$INSTALL_CODEX" == 'true' ]]; then
  npm install -g @openai/codex@latest
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN is required (set in env or $ENV_FILE)." >&2
  exit 1
fi

if [[ "${CODEX_PROVIDER:-codex}" == 'codex' ]] && [[ -z "${OPENAI_API_KEY:-}" ]] && [[ -z "${CODEX_EXEC_COMMAND:-}" ]]; then
  if "${CODEX_BIN:-codex}" login status >/dev/null 2>&1; then
    echo "No OPENAI_API_KEY set; using existing codex login session."
  else
    echo "OPENAI_API_KEY is required for codex provider (or run 'codex login', or set CODEX_EXEC_COMMAND)." >&2
    exit 1
  fi
fi

export PR_NUMBER
export REPAIR_MODE
export REPAIR_TRIGGER
export REPAIR_COMMAND
export IS_EXPLICIT_COMMAND
export CODEX_PROVIDER="${CODEX_PROVIDER:-codex}"
export CODEX_MODEL="${CODEX_MODEL:-}"
export CODEX_BIN="${CODEX_BIN:-codex}"

echo "Running local codex repair for PR #$PR_NUMBER on branch $(git rev-parse --abbrev-ref HEAD)"
node .github/scripts/codex/gather-context.mjs
bash .github/scripts/codex/run-provider.sh
bash .github/scripts/codex/validate.sh

echo "Local codex repair run complete."
