# Session Handoff: Guard Session Server Interference

## Date

2026-06-16

## Apples

Estimated: 🍎🍎🍎
Actual: 🍎🍎🍎
Verdict: 🎯 Exact — cross-session guardrails plus deterministic port wiring landed across the affected automation surfaces without needing extra architectural follow-up.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

1. Investigated historical cross-session contamination in session-state logs and confirmed repeated unsafe shared-port `Stop-Process` patterns across parallel Crawler sessions.
2. Added a new `copilot-guards` shell rule, `shell-unsafe-port-kill`, that denies:
   - shared-port `Get-NetTCPConnection` + `OwningProcess` + `Stop-Process` cleanup on legacy shared ports
   - broad `Get-CimInstance Win32_Process` / `CommandLine` / `Crawler` process sweeps
   - unless the command is explicitly scoped to the current workspace path
3. Added deterministic per-session port derivation in `scripts/shared/session-server-ports.js` with overrides for dev, lab, devtools, and sprite sidecar ports.
4. Wired the derived ports through Vite, sprite sidecar/launcher/CLI flows, save-tuning health checks, sprite gallery lab, devtools, and the Junk Rat sprite E2E script.
5. Added regression coverage for both the new guard and the new session-port helper, then reloaded extensions so the guard is live.

## What's Next

1. Run `npm run verify` before any commit or PR.
2. If other automation scripts still shell out with hardcoded ports outside this repo, migrate them onto the same session-port helper.

## Blockers

None.

## Branch State

- Branch: `nalfeo/investigate-session-interference`
- All tests passing: yes (`node --test ".github/extensions/copilot-guards/tests/*.test.mjs"` and `npm run verify:fast`)
- PR created: no

## Test Results

- `node --test ".github/extensions/copilot-guards/tests/*.test.mjs"` ✅
- `npm run verify:fast` ✅

## Key Decisions Made

1. Enforce safety at the guard layer first instead of relying on convention in agent-authored shell commands.
2. Use deterministic workspace-derived ports rather than a shared registry so parallel worktrees stop colliding without introducing extra coordination infrastructure.
