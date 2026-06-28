#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="${GITHUB_WORKSPACE:-$(pwd)}"
RESULT_PATH="${CODEX_RESULT_PATH:-$WORKSPACE/.github/scripts/codex/runtime/codex-result.json}"
VALIDATION_REPORT_PATH="${CODEX_VALIDATION_REPORT_PATH:-$WORKSPACE/.github/scripts/codex/runtime/validation-report.json}"

if [[ -n "${CODEX_VALIDATION_COMMANDS:-}" ]]; then
  mapfile -t COMMANDS < <(printf '%s\n' "$CODEX_VALIDATION_COMMANDS" | sed '/^\s*$/d')
else
  COMMANDS=()
  if [[ -f "$WORKSPACE/package-lock.json" ]]; then
    COMMANDS+=("npm run verify:fast")
  elif [[ -f "$WORKSPACE/pnpm-lock.yaml" ]]; then
    COMMANDS+=("pnpm run verify:fast")
  elif [[ -f "$WORKSPACE/yarn.lock" ]]; then
    COMMANDS+=("yarn verify:fast")
  elif [[ -f "$WORKSPACE/poetry.lock" ]] || [[ -f "$WORKSPACE/pyproject.toml" ]]; then
    COMMANDS+=("pytest -q")
  elif compgen -G "$WORKSPACE/*.sln" >/dev/null; then
    COMMANDS+=("dotnet test")
  fi
fi

mkdir -p "$(dirname "$VALIDATION_REPORT_PATH")"

python - "$VALIDATION_REPORT_PATH" <<'PY'
import json, sys
path=sys.argv[1]
json.dump({"commands": [], "results": [], "all_passed": True}, open(path, "w"))
PY

if [[ ${#COMMANDS[@]} -eq 0 ]]; then
  echo "No validation command detected; skipping"
  exit 0
fi

ALL_PASSED=true
TMP_RESULTS=()

for cmd in "${COMMANDS[@]}"; do
  echo "Running validation: $cmd"
  set +e
  output=$(bash -lc "$cmd" 2>&1)
  status=$?
  set -e

  excerpt=$(printf '%s' "$output" | tail -n 120)
  success=false
  if [[ $status -eq 0 ]]; then
    success=true
  else
    ALL_PASSED=false
  fi

  python - "$VALIDATION_REPORT_PATH" "$cmd" "$success" "$excerpt" <<'PY'
import json, sys
path, cmd, success, excerpt = sys.argv[1:5]
data = json.load(open(path))
data["commands"].append(cmd)
data["results"].append({
  "command": cmd,
  "success": success == "true",
  "output_excerpt": excerpt,
})
data["all_passed"] = data.get("all_passed", True) and (success == "true")
json.dump(data, open(path, "w"), indent=2)
PY

  if [[ $status -ne 0 ]]; then
    echo "$output"
  fi
done

if [[ "$ALL_PASSED" != "true" ]]; then
  exit 1
fi
