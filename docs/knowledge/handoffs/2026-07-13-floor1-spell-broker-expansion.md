# Handoff — 2026-07-13 — Floor 1 spell broker expansion

## Systems touched

docs-tooling

## Summary

- Expanded the Floor 1 spell broker reward pool from 3 to 10 implemented spells and changed the boss reward to offer a deterministic cached 3-of-10 trio per run.
- Added seven new authored spells (`magic-missile`, `frost-nova`, `bless`, `stoneskin`, `curse`, `vampiric-touch`, `haste`) with runtime effects and visible VFX.
- Rewired the reward modal to consume game-layer-provided offered spell options instead of hardcoded Fireball/Heal/Pulse Shield copy.
- Preserved AI survivability by preferring `heal` when it appears in the offered trio, while still respecting the sampled offer.

## Persona(s) adopted

- Producer (multi-layer orchestration)
- Game Designer / Systems Engineer / UX-adjacent implementation within one session

## Routing verdict

✅ Recommended — the feature fit the existing spell/effect/VFX architecture, so extending the current catalog was safer than inventing a second reward-spell system.

## Apples

- Estimated: 🍎🍎🍎
- Actual: 🍎🍎🍎🍎
- Verdict: under by 1 — the gameplay feature itself fit 3🍎, but the repo-required review ledger + ADR + cross-layer reward-offer plumbing made it a 4🍎 landing.

## Review Harness

- Ledger: `docs/knowledge/review-ledgers/2026-07-13-floor1-spell-broker-expansion.review-ledger.json`
- Plan review: `claude-sonnet-4.6` — 3 concerns, all resolved
- Code review: `claude-sonnet-4.6` — round 1 found 3 valid issues; round 2 clean

## What changed

1. **Deterministic reward offer**
   - `src/shared/abilities.ts`
   - `src/shared/floor-types.ts`
   - `src/game/floorScenario.ts`
   - Reward pool is now 10 ids with `FLOOR1_BOSS_REWARD_SPELL_OFFER_COUNT = 3`.
   - Offer sampling uses `hashStringToSeed(`${world.seed}:floor1-spell-reward-offer`)`.
   - The sampled trio is cached on `world.floorScenario.offeredRewardSpellIds`.
   - `selectSpellFromBossBattle()` now validates against the offered trio, not the full pool.

2. **Seven new spells**
   - `src/game/abilities/registry.ts`
   - `src/shared/progression-effects.ts`
   - `src/game/abilities/types.ts`
   - `src/game/systems/progressionEffects.ts`
   - Added new spell mechanics:
     - `spell_magic_missile`
     - `spell_frost_nova`
     - `spell_timed_buff`
     - `spell_enemy_slow_burst`
     - `spell_life_drain`

3. **New spell VFX**
   - `src/shared/vfx-events.ts`
   - `src/engine/EffectsVfx.ts`
   - Added visible cast feedback for the new spell family:
     - `arcaneBoltImpact`
     - `frostNovaBurst`
     - `buffAura`
     - `curseBurst`
     - `lifeDrainBurst`

4. **Runtime/UI/lab wiring**
   - `src/bootstrap/floor-main-scene-options.ts`
   - `src/engine/scenes/MainGameScene.ts`
   - `src/game/ai/auto-progression.ts`
   - `src/labs/ai-runner-lab/index.ts`
   - The modal now renders the current offered trio via injected scene options.
   - AI reward claiming now prefers offered `heal`, else first offered spell.
   - AI Runner Lab reward-claim path now selects from the offered trio instead of hardcoding `fireball`.

5. **Tests**
   - `tests/game/floor1-scenario.test.ts`
   - `tests/game/auto-progression-npc.test.ts`
   - `tests/game/ability-registry.test.ts`
   - `tests/game/ability-system.test.ts`
   - Added coverage for offer stability/validation, new spell registry coverage, new spell effect execution, new spell VFX events, and AI heal preference within the offered trio.

## Validation

- `npx vitest run tests/game/floor1-scenario.test.ts tests/game/auto-progression-npc.test.ts tests/game/ability-system.test.ts tests/game/ability-registry.test.ts` ✅
- `npx vitest run tests/game/auto-progression-npc.test.ts tests/game/ability-system.test.ts` ✅ (review-fix regression pass)
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-13-floor1-spell-broker-expansion.review-ledger.json` ✅

## Observe before done

- **Before:** the reward modal always exposed the same three hardcoded spells; AI/manual validation could still learn any pool id once the pool expanded; the new spell set did not exist in runtime or the abilities lab.
- **After:** reward choice is a deterministic 3-of-10 run-specific trio, selection is constrained to that trio, the abilities lab can equip/fire all ten spells, and each new spell emits visible cast feedback through the real VFX pipeline.

## ADR

- `docs/knowledge/adr/2026-07-13-floor1-spell-broker-offer-and-catalog.md`

## Blockers

- None.

## Agent-OS telemetry

- No `files/guard-telemetry.jsonl` present this session, so no telemetry capture file was required.
