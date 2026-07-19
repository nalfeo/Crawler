# Handoff: equipment scoring + CI recovery follow-up

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy, ai-behavior-tree, inventory, weapons

## Apples

Estimated 2 apples, actual 2 apples.

## What changed

- Root-caused the reported `Format & Labs` blocker to the `Guard + review-ledger tests` step, not formatting or lab registration.
- Fixed `.github/scripts/ci-recovery/reconcile.mjs` so stale trusted markers do **not** auto-resolve outdated threads; only threads with no trusted marker receive the reconciler-authored outdated marker.
- Addressed the branch review findings in the equipment evaluator and carryover code:
  - passive-grant stat effects now contribute to evaluator scoring,
  - weapon-prerequisite passives are filtered against the hypothetical weapon snapshot,
  - dual-source passives/configured actives can be preserved across displacement via explicit non-equipment subsets in `CurrentLoadoutState`,
  - equipment-only carryover cooldown entries are stripped when the granted active itself is stripped,
  - the equipment-evaluator lab fixtures now use schema-valid rarity and slot ids.
- Added regression coverage for passive-grant scoring, weapon-gated passive swaps, dual-source passive preservation, and the carryover cooldown filtering case.
- Completed the missing 4🍎 review ledger stages for the existing `h1-equipment-loadout-scoring` branch so `verify:pr-prereqs` can pass.

## Observe before done

- Before: the CI job named `Format & Labs` failed in `Guard + review-ledger tests`, and local `npm run test:guards` reproduced a stale-marker reconcile failure. The evaluator also ignored passive stat effects entirely, so passive-grant items were undervalued.
- After: `npm run test:guards` passes, `npm run verify:fast` passes after the evaluator/carryover follow-up fixes, and the updated review ledger validates cleanly for the branch's 4-apple tier.

## Verification run

- `npm run test:guards`
- `npx vitest run tests/game/equipment-evaluator.test.ts tests/unit/player-carryover.test.ts`
- `npm run typecheck -- --pretty false`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-19-h1-equipment-loadout-scoring.review-ledger.json`

## Unresolved issues

- None in local verification. Two round-2 reviewer concerns about `reconcile.mjs` were adjudicated as substantive policy disagreement with the current stale-marker contract, not code defects in the intended behavior.
