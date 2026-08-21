# Handoff: touch issue form dismissal

## Systems touched

mobile-ux

## Apples

Estimated: 2. Actual: 2. 🎯 Exact — a shared modal-input fix and one real-scene regression test.

## Summary

- Made cancellable modal-picker backdrops dismiss on touch outside the panel.
- Advertised the touch cancellation gesture in the picker footer.
- Kept non-cancellable pickers and taps inside the panel unchanged.
- Added a real `MainGameScene` Playwright regression test for the issue form.

## Files touched

- `src/engine/ModalPickerUI.ts`
- `tests/e2e/main-game-scene-ui-exclusivity.test.ts`

## Observation

- Before: the issue picker could only be dismissed with Escape; tapping outside it did nothing.
- After: the real scene test confirms an in-panel tap leaves the picker open, while an outside tap closes it and restores the prior simulation pause state.

## Verification

- `npx vitest run --project e2e tests/e2e/main-game-scene-ui-exclusivity.test.ts --reporter=verbose`
- `npm run verify:fast`
- `runtime-tools-secret_scanning`
- `code_review` (one remaining false-positive finding: `panel` explicitly uses `setOrigin(0, 0)`)
- `codeql_checker` (analysis skipped because the JavaScript database exceeded the tool size limit)

## Unresolved issues

- None.

## Recommended next steps

- Create a ready-for-review PR that closes #3134 and includes the authorized plan summary in its description.
