# Handoff: Floor 3 starter boss-sprite temporary placeholders

## Date

2026-09-07

## Verdict

Recommended. The fix stays presentation-only: it swaps the Floor 3 starter-picker visuals to a deterministic Floor 2 boss-mob sprite mapping and leaves the underlying species roster and gameplay rules unchanged.

## Persona

Producer

## Systems touched

hud-ux, sprite-pipeline

## Apples

Estimated 2🍎, actual 2🍎.

## What Was Done

- Added a deterministic temporary Floor 3 starter sprite mapping that resolves each starter offer to a valid Floor 2 boss-mob sprite.
- Extended modal option metadata so the UI can render a sprite alongside the candidate text.
- Updated the real modal renderer to draw the mapped sprite in the starter picker without affecting other pickers.
- Added unit coverage for the starter-mapping contract and the fallback placeholder behavior.

## Review Finding Addressed

The starter-picker presentation had no deterministic sprite fallback and could resolve to a missing or generic placeholder. The mapping is now isolated to the temporary Floor 3 starter UI and uses existing boss-mob sprites from the shipped Floor 2 set.

## Observe Before Done

The change is wired through the real `MainGameScene` + `ModalPickerUI` path used by the Floor 3 starter modal, and the starter UITest coverage asserts each offered choice carries a valid `mob-*` sprite ID unique to the temporary presentation layer.

## Validation

- `npm run test:unit -- --run tests/unit/floor3-ux-surfaces.test.ts`
- `npm run typecheck -- --pretty false`
- `bash scripts/agent/verify-fast.sh`
