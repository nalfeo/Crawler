#!/usr/bin/env bash
set -euo pipefail

# ===========================================================================
# Kickoff phase timing
# Each phase records its wall-clock start and end so the human-facing output
# and the machine-readable artifact (files/preflight-timing.json) both report
# where time was actually spent.
# ===========================================================================
PREFLIGHT_TIMING_FILE="${PREFLIGHT_TIMING_FILE:-files/preflight-timing.json}"
_clock() { date +%s 2>/dev/null || echo 0; }
PREFLIGHT_START_S="$(_clock)"
PREFLIGHT_ISO="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "")"

# Parallel indexed arrays: _phase_names[i], _phase_starts[i], _phase_durs[i], _phase_notes[i]
_phase_names=()
_phase_starts=()
_phase_durs=()
_phase_notes=()

_phase_start() {
  local name="$1"
  _phase_names+=("$name")
  _phase_starts+=("$(_clock)")
  _phase_durs+=("0")
  _phase_notes+=("")
  printf '⏱  [preflight] %s…\n' "$name"
}

_phase_end() {
  local note="${1:-}"
  local idx=$(( ${#_phase_names[@]} - 1 ))
  local dur=$(( $(_clock) - _phase_starts[$idx] ))
  _phase_durs[$idx]="$dur"
  _phase_notes[$idx]="$note"
}

_phase_skip() {
  local note="${1:-skipped}"
  local idx=$(( ${#_phase_names[@]} - 1 ))
  _phase_durs[$idx]="0"
  _phase_notes[$idx]="$note"
}

_write_timing_artifact() {
  local total_end
  total_end="$(_clock)"
  local total_s=$(( total_end - PREFLIGHT_START_S ))

  mkdir -p "$(dirname "$PREFLIGHT_TIMING_FILE")"

  # Determine warmCache: true only when the three infrastructure phases
  # (deps, playwright, typecheck) were all skipped because their state was
  # already satisfied.  The informational phases (memory_seed, persona_hint,
  # handoff_digest) are always fast and do not affect this flag.
  local warm_cache="true"
  local i
  for (( i=0; i<${#_phase_names[@]}; i++ )); do
    local _pname="${_phase_names[$i]}"
    local _note="${_phase_notes[$i]}"
    # Only the infrastructure phases count for warmCache.
    case "$_pname" in
      deps|playwright|typecheck)
        case "$_note" in
          *skip*|*cached*|*already*|*unchanged*) : ;;  # correctly skipped
          *) warm_cache="false" ;;
        esac
        ;;
    esac
  done

  local met_target="false"
  [ "$total_s" -le 30 ] && met_target="true"

  # Build JSON phases array
  local phases_json="["
  local first="true"
  for (( i=0; i<${#_phase_names[@]}; i++ )); do
    local name="${_phase_names[$i]}"
    local start_offset=$(( _phase_starts[$i] - PREFLIGHT_START_S ))
    local dur="${_phase_durs[$i]}"
    local note="${_phase_notes[$i]}"
    local skipped="false"
    # A phase is skipped when its note contains canonical skip keywords.
    # Deliberately excludes 'not found' (a failure) and 'completed' (a real run).
    case "$note" in
      *skip*|*cached*|*already*|*unchanged*) skipped="true" ;;
    esac

    [ "$first" = "true" ] || phases_json+=","
    first="false"
    phases_json+="$(printf '\n    {"name":"%s","startS":%d,"durationS":%d,"skipped":%s,"note":"%s"}' \
      "$name" "$start_offset" "$dur" "$skipped" "${note//\"/\\\"}")"
  done
  phases_json+=$'\n  ]'

  printf '{\n  "schema": "agent-os-preflight-timing/v1",\n  "timestamp": "%s",\n  "phases": %s,\n  "totalS": %d,\n  "warmCache": %s,\n  "metTarget30s": %s\n}\n' \
    "$PREFLIGHT_ISO" "$phases_json" "$total_s" "$warm_cache" "$met_target" \
    > "$PREFLIGHT_TIMING_FILE"

  if [ "$met_target" = "false" ]; then
    printf '⚠️  Preflight took %ds — exceeded 30s warm-cache target.\n' "$total_s"
    printf '   Active phases:\n'
    for (( i=0; i<${#_phase_names[@]}; i++ )); do
      local d="${_phase_durs[$i]}"
      [ "$d" -gt 1 ] && printf '     %-20s %ds  %s\n' "${_phase_names[$i]}" "$d" "${_phase_notes[$i]}"
    done
    printf '   Timing artifact: %s\n' "$PREFLIGHT_TIMING_FILE"
  else
    printf '✅ Preflight complete in %ds — within 30s warm-cache target.\n' "$total_s"
    printf '   Timing artifact: %s\n' "$PREFLIGHT_TIMING_FILE"
  fi
}

# ===========================================================================
# Portable node binary resolution
# On Git Bash for Windows, 'node' is often absent from the shell PATH even
# though npm/npx work fine (they use .cmd wrappers). Look for node next to
# the npm binary as a fallback so the memory-seed step can run.
# ===========================================================================
_resolve_node_bin() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  # Fallback: node lives in the same prefix directory as npm.
  # Uses dirname directly (no readlink) for portability across Linux, macOS,
  # and Git Bash on Windows.  On Windows — the primary use case — npm.cmd is
  # not a symlink, so dirname is always correct.
  local _npm_bin
  _npm_bin="$(command -v npm 2>/dev/null || true)"
  if [ -n "$_npm_bin" ]; then
    local _npm_dir
    _npm_dir="$(dirname "$_npm_bin")"
    for _candidate in "$_npm_dir/node" "$_npm_dir/node.exe"; do
      [ -f "$_candidate" ] && { echo "$_candidate"; return 0; }
    done
  fi
  echo ""
  return 1
}
NODE_BIN="$(_resolve_node_bin 2>/dev/null || true)"

# ===========================================================================
# Playwright Chromium cache detection
# Reads the revision from node_modules/playwright-core/browsers.json and
# verifies the binary exists before attempting a (re-)install.  This avoids
# a ~25s npx + download cycle on every warm-cache session.
# ===========================================================================
_playwright_chromium_cached() {
  local manifest="node_modules/playwright-core/browsers.json"
  [ -f "$manifest" ] || return 1

  # Extract revision of the installByDefault chromium entry.
  # The manifest is pretty-printed with spaces ("revision": "1223"),
  # so allow optional whitespace between key, colon, and value.
  local revision
  revision="$(grep -o '"revision": *"[0-9]*"' "$manifest" | head -1 | grep -o '[0-9][0-9]*' || true)"
  [ -z "$revision" ] && return 1

  local cache_dir="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/.cache/ms-playwright}"
  local base="$cache_dir/chromium-$revision"

  # Check all platform binary locations.
  [ -f "$base/chrome-linux64/chrome" ]               && return 0
  [ -f "$base/chrome-win64/chrome.exe" ]             && return 0
  [ -d "$base/chrome-mac-arm64/Chromium.app" ]       && return 0
  [ -d "$base/chrome-mac-x64/Chromium.app" ]         && return 0
  return 1
}

# ===========================================================================
# Incremental typecheck: skip when no TypeScript inputs have changed
# Uses 'git ls-files -s' to fingerprint the tracked index state of every .ts
# file and tsconfig; also captures any working-tree diffs so uncommitted edits
# are detected.  The sentinel is invalidated by npm ci (which rewrites
# node_modules) so a dep upgrade always re-runs typecheck.
# ===========================================================================
TYPECHECK_SENTINEL="node_modules/.preflight-typecheck-state"
_ts_input_state() {
  if ! command -v git >/dev/null 2>&1; then
    echo ""
    return
  fi
  # Index object hashes for all tracked .ts and tsconfig files, plus any
  # working-tree diffs.  Intentionally includes tsconfig.*.json variants.
  { git ls-files -s '*.ts' 'tsconfig.json' 'tsconfig.*.json' 2>/dev/null; \
    git diff HEAD -- '*.ts' 'tsconfig.json' 'tsconfig.*.json' 2>/dev/null; } \
    | sha256sum 2>/dev/null | cut -d' ' -f1 || echo ""
}

# ===========================================================================
# Phase 1: Dependencies
# ===========================================================================
echo "🔧 Preflight: Installing dependencies..."
_phase_start "deps"
LOCK_HASH_FILE="node_modules/.preflight-lock-hash"
compute_lock_hash() {
  if command -v git >/dev/null 2>&1; then
    git hash-object package-lock.json 2>/dev/null && return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum package-lock.json | cut -d' ' -f1 && return 0
  fi
  echo ""
}
lock_hash="$(compute_lock_hash)"
if [ -n "$lock_hash" ] && [ -d node_modules ] && [ -f "$LOCK_HASH_FILE" ] \
  && [ "$(cat "$LOCK_HASH_FILE" 2>/dev/null)" = "$lock_hash" ]; then
  echo "   ✓ node_modules already matches package-lock.json — skipping npm ci."
  _phase_skip "lockfile unchanged — npm ci skipped"
else
  npm ci --prefer-offline --silent
  [ -n "$lock_hash" ] && printf '%s' "$lock_hash" > "$LOCK_HASH_FILE"
  # Any npm ci invalidates the typecheck sentinel (dep types may have changed).
  rm -f "$TYPECHECK_SENTINEL"
  _phase_end "npm ci completed"
fi

# ===========================================================================
# Phase 2: Playwright Chromium
# ===========================================================================
echo "🌐 Preflight: Installing Playwright Chromium browser..."
_phase_start "playwright"
if _playwright_chromium_cached; then
  echo "   ✓ Playwright Chromium already cached — skipping install."
  _phase_skip "chromium already cached"
else
  npx playwright install chromium
  _phase_end "playwright install completed"
fi

# ===========================================================================
# Phase 3: Typecheck (incremental)
# ===========================================================================
echo "🔍 Preflight: Type checking..."
_phase_start "typecheck"
_ts_state="$(_ts_input_state)"
if [ -n "$_ts_state" ] && [ -f "$TYPECHECK_SENTINEL" ] \
  && [ "$(cat "$TYPECHECK_SENTINEL" 2>/dev/null)" = "$_ts_state" ]; then
  echo "   ✓ No TypeScript changes since last typecheck — skipping."
  _phase_skip "TypeScript inputs unchanged — typecheck skipped"
else
  npx tsc --noEmit
  [ -n "$_ts_state" ] && printf '%s' "$_ts_state" > "$TYPECHECK_SENTINEL"
  _phase_end "typecheck completed"
fi

# ===========================================================================
# Phase 4: Memory seed
# ===========================================================================
echo "🧠 Preflight: Seeding agent memory graph..."
_phase_start "memory_seed"
# Creates and one-time-seeds the per-user live memory graph from the committed
# snapshot so the MCP memory server has facts on first launch. Never overwrites
# an existing live file. Non-fatal: memory is an enhancement, not a gate.
#
# Uses NODE_BIN (resolved above) to handle Git Bash environments where 'node'
# is absent from the shell PATH even though npm/npx are available.
if [ -n "$NODE_BIN" ]; then
  "$NODE_BIN" scripts/agent/mcp-memory-server.mjs --ensure \
    || echo "⚠️  Memory seed skipped (non-fatal)"
  _phase_end "memory graph seeded"
else
  echo "⚠️  Memory seed skipped — node binary not found (PATH or npm-sibling lookup failed)"
  _phase_skip "node not found — memory seed skipped"
fi

# ===========================================================================
# Phase 5: Persona routing hint (non-blocking)
# ===========================================================================
persona_hint() {
  echo "🎭 Preflight: Persona routing hint"
  echo "   Select your persona from docs/agent-os/personas/README.md"
  echo "   (default to Producer for multi-layer or ambiguous tasks)."

  local base changed
  base="$(git merge-base HEAD origin/main 2>/dev/null || true)"
  [ -z "$base" ] && return 0
  changed="$(git diff --name-only "$base" 2>/dev/null || true)"
  [ -z "$changed" ] && return 0

  declare -A suggested=()
  while IFS= read -r f; do
    case "$f" in
      src/core/*) suggested["Systems Engineer"]=1 ;;
      src/shared/data/quests.*|src/game/floor*Scenario*) suggested["Content Designer"]=1 ;;
      src/game/*) suggested["Game Designer"]=1 ;;
      src/labs/*) suggested["Game Designer"]=1 ;;
      briefs/*|data/palettes/*|src/engine/sprites/*) suggested["Graphics Designer"]=1 ;;
      src/engine/*) suggested["UX Designer"]=1 ;;
      tests/*) suggested["QA Engineer"]=1 ;;
      .github/workflows/*|scripts/agent/*) suggested["DevOps Engineer"]=1 ;;
    esac
  done <<< "$changed"

  if [ "${#suggested[@]}" -gt 0 ]; then
    echo "   Changed paths suggest: ${!suggested[*]}"
    [ "${#suggested[@]}" -gt 1 ] && echo "   Multiple layers touched — consider adopting Producer to coordinate."
  fi
  return 0
}
_phase_start "persona_hint"
persona_hint || true
_phase_end "persona hint done"

# ===========================================================================
# Phase 6: Handoff digest (non-blocking)
# ===========================================================================

# Non-blocking lessons-learned digest. Prints the `### Mistakes Made` and
# `### Lessons Learned` sections from the 5 most recent non-archived handoffs
# (sorted by filename date-prefix, descending). Quiet-fails if the handoffs
# directory is missing. Closes the "written but not read" loop the 2026-07-03
# audit surfaced.
handoff_digest() {
  local dir="docs/knowledge/handoffs"
  [ -d "$dir" ] || return 0
  echo "===== Recent handoff lessons (top 5, most recent first) ====="
  local files
  files=$(find "$dir" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-*.md' 2>/dev/null | sort -r | head -n 5)
  [ -z "$files" ] && { echo "(no dated handoffs found)"; echo "============================================================="; return 0; }
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    local slug
    slug=$(basename "$f" .md)
    echo "$slug:"
    awk '
      function flush() {
        if (sect=="L" && buf!="") print "  Lessons: " buf;
        if (sect=="M" && buf!="") print "  Mistakes: " buf;
      }
      /^### Lessons Learned[[:space:]]*$/  { flush(); sect="L"; buf=""; next }
      /^### Mistakes Made[[:space:]]*$/    { flush(); sect="M"; buf=""; next }
      /^###[[:space:]]/ || /^##[[:space:]]/ { flush(); sect=""; buf=""; next }
      sect!="" && $0 !~ /^[[:space:]]*$/ && $0 !~ /^[[:space:]]*<!--/ { line=$0; sub(/^[[:space:]]*[-*+][[:space:]]+/, "", line); if (buf=="") buf=line; else if (length(buf) < 160) buf=buf "; " line }
      END { flush() }
    ' "$f"
  done <<< "$files"
  echo "============================================================="
}
_phase_start "handoff_digest"
handoff_digest || true
_phase_end "handoff digest done"

# ===========================================================================
# Write timing artifact and final summary
# ===========================================================================
_write_timing_artifact

