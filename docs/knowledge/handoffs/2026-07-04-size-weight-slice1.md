# Handoff: Size + weight — Slice 1 (Size component foundation)

**Date**: 2026-07-04
**Session**: size-weight-slice1 (branch `nalfeo-size-weight-slice1`)
**Persona**: Producer → Combat Systems
**Apples**: 🍎🍎🍎 (estimate) / 🍎🍎🍎 (actual)

## Systems touched: enemies, weapons, ai-combat-balance

## Summary

Slice 1 of the "true size + weight" system per ADR 0044 and spec `.specify/specs/entity-physics.md`. Introduces the canonical `Size` ECS component + `physics-defs.ts` registry as the single source of truth for entity half-extents, migrates every core consumer to read via the new `physics-body.ts` helper, burns the sprite half-extent fallback shim, and locks the surface with three CI gates + an ESLint rule + a headless parity test.

**Hard invariant preserved**: every numeric value in `physics-defs.ts` is bit-identical to today's shipping sprite half-extents. `tests/headless/collision-pair-parity.test.ts` (seed 42, 1500 frames) fingerprints `RunStats` (totalFrames, outcome, kills, damageDealt, damageTaken, finalScore) and passes — no gameplay tuning happens in Slice 1.

Weight-driven knockback semantics are **deferred to Slice 2**.

## What shipped

### Component + registry

- `src/core/components.ts` — new `Size` component (`radius`, `halfWidth`, `halfHeight`, `shape`).
- `src/core/world.ts` — new `size` store.
- `src/core/physics-defs.ts` — canonical registry of body defs per entity class, mirroring `docs/knowledge/game-design/entity-sizing.md`.
- `src/core/physics-body.ts` — read-side helpers (`getBodyHalfWidth`, `getBodyHalfHeight`, `getBodyRadius`, `hasValidSize`) and shim diagnostic counters (`resetShimStats`, `getShimStats`).

### Migrated consumers

- `src/core/systems/collisionSystem.ts` — query flipped to `[Position, Size]`, half-extents via helpers.
- `src/core/systems/knockbackSystem.ts` — `isFootprintPassable` via helpers.
- `src/core/apply-damage.ts` — sprite-width read via `getBodyHalfWidth * 2`.
- `src/core/systems/dropSystem.ts` — parent-dim reads via helpers; mini-slime split now attaches `Size`.
- `src/game/weaponSystem.ts` — target radius via `getBodyRadius`.

### Spawners now attach Size

- `src/core/spawners/combatants.ts` (player, mob, npc, spawner-structure, boss)
- `src/core/spawners/projectiles.ts`
- `src/core/spawners/pickups.ts`
- `src/core/spawners/world-objects.ts`
- `src/core/spawners/melee.ts`
- Plus custom spawn sites: `src/game/floorScenario.ts` (welcome sign, ratSlime boss, slimeRat boss, F1 mob archetype), `src/game/floor2Scenario.ts` (boss archetype), `src/game/spawners/spawnerSystem.ts`.

### Gates

- `scripts/agent/health/check-physics-defs-sync.ts` — parses `entity-sizing.md`, diffs against `physics-defs.ts`; exit 1 on drift.
- `scripts/agent/health/check-size-coverage.ts` — headless seed-42 800-frame run; asserts `getShimStats().count === 0`.
- `tests/unit/core/physics-defs.test.ts` — R6 coverage.
- `tests/headless/collision-pair-parity.test.ts` — R8 deterministic parity guard.
- `scripts/agent/verify-fast.sh` Step 4 wires both new checks.
- `eslint.config.js` — `no-restricted-syntax` rule blocking `.sprite.width|height` member reads in `src/core/**`, `src/game/**`, `tests/**`, `scripts/**` (exemptions: `src/core/physics-body.ts`, `tests/ecs/knockback-system.test.ts`, `tests/**/collision-*.test.ts`).

### Lab

- `src/labs/physics-body-lab/index.ts` — slug `size-body`. Renders body outlines (green) vs sprite outlines (red) with lil-gui sliders per entity class from the registry.

## Observed behavior (Rule #10)

**Real pipeline — headless AI runner** (`npx tsx src/game/ai/headless-runner-cli.ts --seed 42 --frames 2000`):

```
Outcome:      VICTORY
Final Score:  68
Total Frames: 14464
Kills:        138
killsByType:  { rat: 23, slime: 12 }
damageDealt:  3630
damageTaken:  118.76
```

**Coverage gate** (`npx tsx scripts/agent/health/check-size-coverage.ts`):

```
[INFO] OK: seed=42 frames=800 damage=82.5 — every collision-grid entity had a
       valid Size (0 shim fallbacks)
```

**Parity headless test** (`npx vitest run tests/headless/collision-pair-parity`): ✅ pass, 4.6 s.

Lab-only validation would not be sufficient here per Rule #10 — the coverage gate and parity test both run against the real `simulation-step.ts` pipeline (`src/game/ai/simulation-step.ts` via the AI headless runner). The `physics-body-lab` is purely a diagnostic surface.

## Verification snapshot

- `npx tsc --noEmit --project tsconfig.src.json` — clean
- `npx eslint src/core src/game --max-warnings 0` — clean (0 `sprite.width|height` violations)
- `npx vitest run tests/ecs/collision-system tests/ecs/knockback-system tests/ecs/melee-broadphase-determinism tests/headless/collision-pair-parity tests/unit/core/physics-defs` — all pass
- `check-size-coverage` — clean
- `check-physics-defs-sync` — clean

## Files touched

28 files changed, +1105 / −38. See commit `977719bf`.

## Apple actuals

| Aspect          | Estimate       | Actual    | Reason                                                                                                                                          |
| --------------- | -------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Systems touched | 3              | 3         | enemies, weapons, ai-combat-balance                                                                                                             |
| New CI gates    | 3              | 3         | physics-defs-sync, size-coverage, parity                                                                                                        |
| Files migrated  | ~10            | 28        | Spawn sites in `floorScenario.ts`/`floor2Scenario.ts` needed catchup Size attachments discovered only after coverage gate failed the first time |
| Novel risk      | numeric parity | preserved | Locked in by parity fingerprint                                                                                                                 |

**Verdict**: 🍎🍎🍎 was accurate. The unforeseen work was custom spawn sites outside `src/core/spawners/**` — a good argument for the coverage gate being CI-mandatory going forward, since new spawn sites will otherwise ship silently without Size and only manifest when they enter the collision grid.

## Follow-ups

- **Slice 2 (sibling session, on top of this branch)** — wires `Weight` component into `knockbackSystem` as a mass denominator. This slice deliberately did not touch weight semantics.
- **AI danger halo scales with Size (deferred to a future `ai-behavior-tree` session):** Session `30a38f32` (Game dev tools research) flagged that once Size ships, `src/game/ai/bt-ai-provider.ts::computeRiskRewardFusedHeading` should replace its flat `RISK_REWARD_DANGER_RADIUS_FT = 15` with a per-enemy scaled radius `RISK_REWARD_DANGER_RADIUS_FT * (Size.radius[eid] / BASE_RADIUS)`, plus mirror the change in `src/labs/ai-runner-lab/index.ts` visualization. This is **out of scope for Slice 1/2** — a separate future session under the `ai-behavior-tree` / `ai-combat-balance` slugs owns it.
- **Floor 2+ static coverage** — `check-size-coverage.ts` currently exercises only Floor 1 in an 800-frame headless slice. Multi-floor sweep or a static per-archetype enumeration (spawn one of each `SPAWNER_ARCHETYPES`/`enemies.floor2.json` entry and assert `hasValidSize`) is a documented follow-up. Complementary defenses today: physics-defs-sync gate, ESLint rule, and `tests/ecs/spawners/*.test.ts`. Slice 2 will exercise Floor 2 via its win-rate sweep.
- **Retune** — every current numeric value in `physics-defs.ts` matches the shipping sprite half-extent. A later slice may retune to the "designed" body sizes from the ADR (with its own win-rate sweep) — that is not this slice's job.
- **Sprite lab writes** — `tests/ecs/knockback-system.test.ts`, `tests/ecs/spawners/**`, `tests/ecs/drop-system.test.ts`, `tests/game/ability-system.test.ts`, and a couple of `collision-*.test.ts` fixtures still write to `stores.sprite.width/height` for setup; the ESLint rule exempts them explicitly. If Slice 2 stops needing those, drop the exemptions.

## Review harness findings addressed

The multi-model code-review round surfaced five critical issues before landing; all were fixed in this branch:

1. **Parity test was self-comparing** — replaced with a hard-coded golden fingerprint captured from `feat/size-weight-design@e8ae8adb`. HEAD run empirically matches base run byte-for-byte.
2. **Welcome sign drift** — 6×3.25 sprite was becoming a CIRCLE with radius=3, nearly doubling its vertical footprint. Fixed to use SHAPE_BOX with (hw=3, hh=1.625).
3. **ESLint failed on 11 test files** — extended the ignore list to include `tests/ecs/spawners/**`, `tests/ecs/drop-system.test.ts`, `tests/game/ability-system.test.ts`.
4. **`tests/game/ability-system.test.ts` broken** — added a matching `Size(hw=1.875, hh=1.875, BOX)` write next to the sprite-dim override for the "wall enemy" fixture.
5. **`getBodyRadius` for BOX diverged from legacy** — changed `Math.hypot(hw, hh)` → `Math.max(hw, hh)` so it matches the old `Math.max(spriteW, spriteH) * 0.5` semantics `weaponSystem` relied on.

Remaining medium-severity findings (docblock accuracy, Floor 2 coverage) are documented above as follow-ups.

## Unresolved issues

None blocking. Slice 2 handoff surface is: helpers in `physics-body.ts`, `SHAPE_CIRCLE`/`SHAPE_BOX` from `physics-defs.ts`, `Size` from `components.ts`. Slice 2 should add `Weight` symmetrically and read via a new helper rather than reaching into stores.
