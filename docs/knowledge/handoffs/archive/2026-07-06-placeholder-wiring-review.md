# Handoff: Placeholder wiring review (Floor 1 prop art)

## Date

2026-07-06

## Systems touched

sprite-pipeline, hud-ux

## Summary

- Ran placeholder audit (`npm run sprites:placeholder-audit -- --all`) and reviewed wiring output.
- Fixed the runtime root cause: `PhaserBridge` was rendering `Prop` entities as placeholder rectangles only.
- Updated prop render pass to prefer real sprite rendering (Kenney or generated texture key) with rectangle fallback when unresolved.
- Wired Floor 1 props to generated art variants:
  - `torch -> prop-torch-v1-var-10`
  - `junk-pile -> prop-junk-pile-v1-var-0`
  - `wall-sconce -> prop-wall-sconce-v1-var-1`
- Synced serialized decoration data (`decorations.json`) by updating torch and adding junk-pile + wall-sconce entries.
- Added regression coverage:
  - decoration wiring assertions in `tests/unit/labs/generationLab.test.ts`
  - renderer-level prop sprite/fallback + destroy cleanup coverage in `tests/unit/phaser-bridge.test.ts`

## Files touched

- `src/engine/PhaserBridge.ts`
- `src/shared/decorationDefs.ts`
- `src/shared/data/decorations.json`
- `tests/unit/labs/generationLab.test.ts`
- `tests/unit/phaser-bridge.test.ts`
- `docs/knowledge/review-ledgers/2026-07-06-placeholder-wiring-review.review-ledger.json`

## Verification run

- `npm run test:unit -- tests/unit/phaser-bridge.test.ts tests/unit/labs/generationLab.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-06-placeholder-wiring-review.review-ledger.json`

## Review harness

- Apple tier: 3
- Ledger: `docs/knowledge/review-ledgers/2026-07-06-placeholder-wiring-review.review-ledger.json`
- Required stages completed: `plan_review`, `code_review`

## Open issues / follow-ups

- Full `npm run verify` still fails in this Windows session on pre-existing `tests/unit/detect-change-scope.test.ts` path handling (`detect-art-only.sh` lookup), unrelated to this prop wiring change.
