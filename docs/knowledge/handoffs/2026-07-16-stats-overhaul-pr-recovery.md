# Handoff: PR #1203 blocker recovery

## Date

2026-07-16

## Persona

Producer -> Systems Engineer / Game Designer / QA Engineer

## Systems touched

ai-combat-balance, inventory, weapons, hud-ux, ci-policy

## Apples

Estimated 🍎🍎, actual 🍎🍎.

## What changed

- Fixed eager equip/unequip max-HP drift by introducing `syncHealthFromDerivedMaxHpDelta` and using it in both `equipmentSystem` eager recompute and `statSystem` per-frame recompute.
- Enforced `weightLb` validation in equipment API boundary (`finite`, `>= 0`) and added ECS coverage.
- Converted timed buff modifier magnitudes to scalable metadata `{ base, scalesWithIntelligence }` across shared types, schema, runtime cast resolution, ability registry data, and schema tests.
- Renamed generated placeholder manifest/art key from `mana-flask` to `recharge-tonic` (`manifest.json` + PNG filename) to restore item icon resolution.
- Corrected stats spec table base `maxHp` value from `90` to `160`.
- Resolved CI headless drift by rebaselining deterministic fingerprints in `collision-pair-parity.test.ts` for this intentional stat-overhaul combat semantics branch.

## Verification

- `npm run test -- tests/ecs/equipment.test.ts tests/unit/ability-schema-constraints.test.ts`
- `npm run test:headless -- tests/headless/collision-pair-parity.test.ts tests/headless/floor1-completion.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- `parallel_validation` (Code Review clean; CodeQL no actionable alerts)

## Review thread outcomes

- `equipmentSystem.ts` maxHp delta: fixed.
- `abilities/types.ts` timed buff scalable metadata: fixed.
- `equipment-types.ts` weight validation: fixed.
- `items.ts` / generated manifest mismatch: fixed.
- `.specify/specs/stats-skills-levels.md` stale maxHp base: fixed.
