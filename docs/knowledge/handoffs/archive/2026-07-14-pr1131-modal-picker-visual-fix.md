# Handoff: PR #1131 modal picker visual fix

**Date:** 2026-07-14
**Session:** pr1131-modal-picker-visual-fix
**Apple estimate (this session):** 🍎🍎 (2)
**PR:** #1131

## Systems touched

hud-ux

## Summary

Recovered the live PR #1131 CI blocker in the real boss reward picker path.
The failing `E2E Visual Regression` job reduced to
`tests/e2e/boss-reward-picker-ux.test.ts`, where the real spell reward modal let
wrapped description text outgrow a fixed 52px row and then let the footer fall
below the fixed 360px panel once the rows were sized correctly.

The fix keeps the existing modal style but makes each option row measure its
actual text height before sizing the backing rectangle, then raises the shared
modal panel height from 360px to 400px so the real Floor 1 boss-reward content
fits inside the panel at both validated viewports.

## Files changed

- `src/engine/ModalPickerUI.ts`
  - Measure option label/description text before finalizing each row height.
  - Advance row layout cumulatively instead of assuming every row is 52px tall.
  - Increase the shared modal panel height to 400px so the footer stays inside
    the real reward-picker panel.
- `docs/knowledge/review-ledgers/2026-07-14-pr1131-modal-picker-visual-fix.review-ledger.json`
  - 2-apple ledger for this follow-up code change.

## Validation

- Reproduced the failure before the fix:
  - `npx vitest run tests/e2e/boss-reward-picker-ux.test.ts`
- Re-observed the real artifact after the fix with the probe lab:
  - `npx tsx - <<'TS' ... loadMainSceneProbeLab(..., 'http://127.0.0.1:5300') ... getModalPickerLayout() ... TS`
- Confirmed the targeted regression is fixed:
  - `npx vitest run tests/e2e/boss-reward-picker-ux.test.ts`
- Repository fast gate:
  - `npm run verify:fast`

## Unresolved issues

- The live GitHub PR title/body still describe the earlier narrow reland scope
  (`feat(hud): reland navigation base UX slice`, 3 apples, arrow geometry not
  included). Repository-side audit trail and review evidence are present, but
  earlier direct PR-metadata patch attempts from this environment returned HTTP 403.

## Recommended next steps

1. Run `npm run verify:pr-prereqs` after this handoff/ledger lands to confirm the
   branch-level guard is green again.
2. If GitHub permissions allow from a higher-privilege context, update PR #1131's
   live title/body to match the actual combined HUD scope already documented in
   the branch handoffs and ledgers.
