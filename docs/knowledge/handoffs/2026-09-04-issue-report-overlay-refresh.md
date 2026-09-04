# Handoff: Issue report overlay refresh flake fix

## Date

2026-09-04

## Persona

QA Engineer

## Systems touched

hud-ux

## Apples

2🍎 estimated, 2🍎 actual (exact). The change was limited to the Issue-report
modal finish path plus a focused regression guard and targeted validation.

## Summary

Fixed the intermittent `main-game-scene-ui-exclusivity` e2e flake where the
Issue button could still read hidden after cancelling the Issue picker over an
open inventory panel. `finishIssueReport()` now closes the dedicated
Issue-report picker before clearing the Issue-open pause sentinel and
immediately refreshes overlay visibility, so the probe cannot observe
`issueReportOpen=false` before `issueButton.visible` has been re-synchronized.

Also fixed a second, unrelated sampling flake surfaced by CI on this branch:
`floor3-ai-runner-dialog-autonomy` asserted the simulation resumed after each
confirmed Floor 3 surface by searching the test's own 1.5s-interval snapshots
for a `modalOpen=false && worldState='playing'` sample. At 16x speed an entire
confirm -> resume -> next-modal window can fall between two polls, so the check
could observe no resume even though the sim ran. The AI Runner lab now records a
`resumed` surface-trace event on its own UI tick once a confirmed surface is
observed unpaused with no modal open, and the test asserts on that event instead
of on sampled snapshots.

## Files touched

- `src/engine/scenes/MainGameScene.ts`
- `src/labs/ai-runner-lab/index.ts`
- `tests/unit/main-game-scene-simulation-pause.test.ts`
- `tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts`
- `docs/knowledge/handoffs/2026-09-04-issue-report-overlay-refresh.md`

## Verification

- `bash scripts/agent/preflight.sh` — passed.
- `npx vitest run tests/unit/main-game-scene-simulation-pause.test.ts` — passed
  (9/9).
- `npx vitest run --project e2e tests/e2e/main-game-scene-ui-exclusivity.test.ts -t "keeps the Issue button clickable over inventory"` —
  passed.
- `npx vitest run --project e2e tests/e2e/main-game-scene-ui-exclusivity.test.ts` —
  passed (25/25).
- `npm run verify:fast` — passed (812 files / 11484 tests; non-blocking data
  contract checks clean).
- `npx vitest run --project e2e-game tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts` —
  passed (previously failed in CI run 33833931218 with "simulation did not
  resume after floor3-keep-companion").
- `npm run verify:pr-prereqs` — initially failed because this handoff was
  missing; passed after adding this file.

## Unresolved issues

- None known for the Issue button flake. The full affected e2e file is slow in
  this environment (~409s) but completed green.

## Recommended next steps

- If CI reports another `main-game-scene-ui-exclusivity` failure, inspect
  whether it is the same Issue-button post-cancel visibility assertion or a
  separate UI exclusivity path before broadening the fix.
