# Handoff — PR #4636 automatic companion growth recovery

## Date

2026-09-20

## Persona

Producer / PR recovery

## Systems touched

hud-ux, unit-tests, agent-workflow-tooling

## Recovery

- Preserved the approved removal of the Floor 3 companion command UI and input;
  no command surface, binding, or command mechanic was restored.
- Updated the corner-button icon guard's canonical list to remove the stale
  `⚡ Command` label.
- Diagnosed the actual Lightweight Checks failure: `getCompanionAttackState` is
  a diagnostic accessor consumed by deterministic tests and excluded labs, not
  shipped gameplay. Added its governed, time-bounded test-scaffold entry rather
  than inventing a gameplay caller.
- The CI log's conflict-marker scan was a false lead: it reported
  `✅ No conflict markers found`; a fresh repository scan and `git diff --check`
  are also clean.
- Rebasing the recovery commit onto current `origin/main` completed without
  conflicts.

## Validation

- Focused unit tests: `main-game-scene-corner-button-icons` and
  `allowlist-expiry` — 60 passing assertions.
- `health-test-only-exports` — no blocking findings.
- `npm run scope` selected simulation, integration, and visual coverage.
- `npm run verify:fast` — passed.
- `npm run verify:pr-prereqs` — passed with Git Bash explicitly ahead of the
  unavailable WSL shim on Windows.
- Fresh complete-diff Ducky review (`codex review --base main`) — no findings;
  patch judged correct. The review's isolated preflight could not write its
  worktree `FETCH_HEAD`, but the owning-session validation above completed.

## Next

Push the rebased recovery head to PR #4636's existing
`codex/floor3-auto-companion-growth` ref and let CI / the merge train handle
remote admission. Do not reintroduce companion commands to satisfy tests.
