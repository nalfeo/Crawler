# Floor 3 AI-runner modal autonomy CI recovery

## Date

2026-09-03

## Persona

QA Engineer

## Systems touched

ai-behavior-tree, hud-ux, quests

## Apples

2🍎 estimated, 2🍎 actual (exact).

## Summary

Recovered the Floor 3 AI-runner modal-autonomy PR from the Unit Tests CI blocker.
The failure was in stale source-string wiring guards that still expected the
older direct modal/auto-progression shapes after the PR intentionally routed lab
modal automation through public `ModalPickerUI.handleKeyDown(Enter)` callbacks
and disabled direct Floor 3 visual-lab shortcuts.

## Files touched

- `tests/unit/ai-shopkeeper-ux-wiring.test.ts`
- `tests/unit/ai-level-up-ux-wiring.test.ts`
- `docs/knowledge/adr/0103-floor3-ai-runner-modal-autonomy.md`
- `docs/knowledge/handoffs/2026-09-03-floor3-ai-runner-modal-autonomy-ci-recovery.md`

## Verification run

- `npm test -- tests/unit/ai-shopkeeper-ux-wiring.test.ts`
- `npm test -- tests/unit/ai-shopkeeper-ux-wiring.test.ts tests/unit/ai-level-up-ux-wiring.test.ts`
- `npm run test:unit`
- `npm run verify:fast`

## Unresolved issues

None known. The CI recovery task comment requested no top-level status replies
for CI-only recovery; progress is represented by branch/check-state changes.

## Recommended next steps

Allow CI to rerun the Unit Tests job on the repaired branch head. If another
modal-autonomy failure appears, inspect the real job logs first and keep any
follow-up fix consolidated into one repair commit.
