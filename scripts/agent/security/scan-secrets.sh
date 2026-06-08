#!/usr/bin/env bash
# security/scan-secrets.sh — regex scan for committed credentials.
#
# Scope: tracked files only (uses `git ls-files`). Skips:
#   - the security scripts themselves (test fixtures of patterns)
#   - node_modules, dist, coverage
#   - lockfiles (npm-shrinkwrap.json, package-lock.json, yarn.lock)
#
# Patterns intentionally kept conservative to limit false positives. Any hit
# fails the script with exit 1. Tighten over time; never loosen.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

EXCLUDES=(
  ':!node_modules/**'
  ':!dist/**'
  ':!coverage/**'
  ':!**/*.lock'
  ':!package-lock.json'
  ':!yarn.lock'
  ':!scripts/agent/security/**'
  ':!docs/knowledge/handoffs/**'
  ':!docs/knowledge/adr/**'
)

# Pattern => human label
declare -A PATTERNS=(
  ['AKIA[0-9A-Z]{16}']="AWS access key"
  ['(ghp|gho|ghu|ghr|ghs)_[A-Za-z0-9]{36,}']="GitHub token"
  ['sk-(proj-)?[A-Za-z0-9_-]{20,}']="OpenAI API key"
  ['xox[abprs]-[A-Za-z0-9-]{10,}']="Slack token"
  ['-----BEGIN (RSA |OPENSSH |DSA |EC |PGP )?PRIVATE KEY-----']="Private key block"
  ['eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}']="JWT-like literal"
)

FAILED=0
echo "[INFO] scan-secrets: scanning tracked files..."
for pattern in "${!PATTERNS[@]}"; do
  label="${PATTERNS[$pattern]}"
  # `git --no-pager grep` returns 1 when no match — that's the success case.
  if hits=$(git --no-pager grep -nE "$pattern" -- "${EXCLUDES[@]}" 2>/dev/null); then
    echo "[ERROR] Potential ${label}:"
    echo "$hits" | sed 's/^/  /'
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "[ERROR] scan-secrets: findings above. Rotate the credential and remove from history."
  exit 1
fi

echo "[INFO] scan-secrets: clean."
exit 0
