# 2026-07-23 — Revert Wave B display-name override authority relocation

## Systems touched

inventory, weapons

## Summary

Reverted `fa1497ca4a3fe413dc405717cce6b73a72c9964a` (PR #1817,
"relocate Wave B display-name override authority to
`floor2-equipment-art.ts`"). That PR was published and merged by a
cancelled session; the maintainer had explicitly decided to keep the
Floor 2 Wave B display-name override table private and runtime-local
inside `src/shared/data/floor2-equipment-wave-b.ts`, and cancelled the
relocation to the canonical art-manifest module.

Used `git revert fa1497ca4a3fe413dc405717cce6b73a72c9964a` — applied
with **zero conflicts** (no later commit touched the same files), so no
manual reconstruction was needed.

## Files touched

- `src/shared/data/floor2-equipment-wave-b.ts` — `WAVE_B_DISPLAY_NAME_OVERRIDES`
  restored as a private, frozen, module-local const (no longer imports/re-exports
  the art-manifest override).
- `src/shared/data/floor2-equipment-art.ts` — removed the exported
  `FLOOR2_WAVE_B_DISPLAY_NAME_OVERRIDES` table and its doc comment.
- `tests/unit/floor2-equipment-wave-b.test.ts` — removed the two
  #1817-specific regression tests ("locates the frozen Wave B
  display-name override authority in the canonical art manifest module
  only" and "applies Wave B display-name overrides only to runtime
  equipment defs...") and their now-unused imports
  (`readFileSync`, `FLOOR2_WAVE_B_DISPLAY_NAME_OVERRIDES`,
  `floor2EquipmentWaveBModule`). Added a new regression guard test,
  "keeps the Wave B display-name override table private and
  runtime-local", asserting the table is not exported from either
  `floor2-equipment-wave-b.ts` or `floor2-equipment-art.ts` under any of
  its possible names — this locks in the reverted (correct) placement
  without reintroducing the removed relocation-specific assertions. All
  other Wave B tests are untouched: uniqueness checks, legacy
  `iron-greaves`/`iron-visor` name checks, canonical `briefInput`
  metadata checks, and roster/runtime-key coverage checks.
- Removed `docs/knowledge/handoffs/2026-07-23-wave-b-display-name-authority-fix.md`
  and `docs/knowledge/review-ledgers/2026-07-23-wave-b-display-name-authority-fix.review-ledger.json`
  (the #1817-specific artifacts).

No unrelated `main` changes were touched. Commit
`22fcfd8e9` (#1824, merged after #1817) does not touch any of the
reverted files, confirmed via
`git log --oneline fa1497ca4..origin/main -- <files>` (empty).

## Verification run

- `npx vitest run tests/unit/floor2-equipment-wave-b.test.ts` — 7/7 passed
  (6 before #1817; #1817 added 2 more, bringing it to 8; this revert
  removes those 2 and adds 1 new private/runtime-local regression guard
  test, netting 7 — one more than the pre-#1817 baseline, by design).
- `npm run verify:fast` — passed (typecheck, lint, physics/size/weight
  coverage checks all green).
- `npm run verify:pr-prereqs` — passed after adding this handoff and a
  2-apple review ledger (no additional review stages required at 2🍎).

## Unresolved issues

None. This is a straight revert restoring prior, maintainer-approved
behavior; no new design decisions were introduced.

## Recommended next steps

None required. If Wave B display-name override authority placement is
revisited in the future, get explicit maintainer sign-off before
publishing/merging — this incident was caused by a cancelled session
publishing a PR the maintainer had already decided against.
