# Floor 2 Slice 3 — family-aware AI

**Date:** 2026-07-03
**Persona:** Systems Designer / AI
**Spec:** `.specify/specs/floor2-family-territories.md` (FR9, FR11, FR12)
**ADR:** `docs/knowledge/adr/0040-floor2-family-territory-and-relationship-architecture.md` D5
**PR:** floor2-slice3-family-ai

## What shipped

Slice 3 makes the relationship bands from Slice 1 actually MEAN something at
runtime. Mobs now pick targets based on their family's band with the player, a
speed ramp kicks in when a family hates the player, and friendly families
follow the player and defend against attackers.

Concretely:

1. **Band-driven target selection** in a new prepass system,
   `familyFeudSystem`, run right before `enemyAISystem` in both the headless
   (`src/game/ai/simulation-step.ts`) and visual
   (`src/bootstrap/floor-main-scene-options.ts`) pipelines.
   - **hate / hostile (0–49):** primary target = player. If player is not
     detectable, fall back to nearest rival via spatial-hash lookup.
   - **neutral (50–75):** ignore player entirely. Target only rival families.
   - **friendly (76–100):** follow player leashed to
     `friendlyLeashTiles` (default 6). When the player is hit, re-target the
     attacker for `friendlyRetaliationMs` (default 5000), then revert.
   - **Trash mobs (no `FamilyMembership`):** unchanged — always target player.

2. **Hate speed ramp (FR9):** for mobs in the hate sub-band (0–24), effective
   speed is folded via `effectiveSpeedForHate` (Slice 1's renamed helper). The
   fold happens in `getEnemySpeed()` inside `enemyAISystem`; status slows still
   take precedence because we `max()` against the status-folded speed.

3. **Feud engagement budget (FR12, ADR 0024):** rival lookups go through a
   per-frame `SpatialHashGrid` scoped to `feudEngagementRadiusTiles` (default
   12). `findNearestRival` trims candidates to `feudCandidateLimit` (default 32) BEFORE the linear-in-k pass. Test enforces the trim.

4. **Retaliation on the existing hit-event bus:** extended `CombatEvent` with
   optional `sourceEid?: number` and populated it on both player-hit paths in
   `damageSystem` (contact + projectile Owner). No parallel bus.

## Files touched

**New:**

- `src/game/systems/familyFeudSystem.ts` — 440-line prepass system
- `src/labs/family-feud-lab/index.ts` — text-mode decision inspector
- `tests/ecs/enemyAISystem.band-targeting.test.ts` (7)
- `tests/ecs/enemyAISystem.hate-ramp.test.ts` (5)
- `tests/ecs/enemyAISystem.ally-defend.test.ts` (3)
- `tests/ecs/enemyAISystem.band-property.test.ts` (2)
- `tests/unit/family-feud-perf.test.ts` (1)

**Modified:**

- `src/shared/data/tuning.json` — 4 new fields under `factionRelations` with `_note` docs
- `src/shared/combat-events.ts` — added `sourceEid?: number`
- `src/core/apply-damage.ts` + `src/core/systems/damageSystem.ts` — plumb sourceEid
- `src/game/enemyAISystem.ts` — consume decisions via `virtualPlayerX/Y` and `familyBypass`; fold speed ramp in `getEnemySpeed`
- `src/game/systems/index.ts` + `src/game/index.ts` — re-exports
- `src/game/ai/simulation-step.ts` + `src/bootstrap/floor-main-scene-options.ts` — wire familyFeudSystem before enemyAISystem
- `src/lab-main.ts` — register `?lab=family-feud-lab`

## API surface (public re-exports on `src/game`)

- `familyFeudSystem(world)` — prepass system
- `getFamilyAIDecision(world, eid)` — read the current decision
- `resolveHostileFallback(...)` — hostile-band player-unreachable fallback
- `findNearestRival(world, grid, selfEid, x, y)` — perf-bounded rival lookup
- `getMobFamilyId(world, eid)` — resolves the numeric slot into a branded `FamilyId`
- `peekFamilyFeudGrid` / `peekFriendlyRetaliation` — debug/test/lab reads
- `isFriendlyInLeash(distanceToPlayer)` — leash helper
- `resetFamilyFeudState(world)` — tests/lab reset

## Tuning defaults

```json
"factionRelations": {
  "friendlyLeashTiles": 6,           "_note.friendlyLeashTiles":       "…",
  "friendlyRetaliationMs": 5000,     "_note.friendlyRetaliationMs":    "…",
  "feudEngagementRadiusTiles": 12,   "_note.feudEngagementRadiusTiles":"…",
  "feudCandidateLimit": 32,          "_note.feudCandidateLimit":       "…"
}
```

## Verification

- `npm run verify:fast` — 1101 tests / 107 files PASS
- `npm run check:wired-systems` — PASS, familyFeudSystem wired into both pipelines
- `npx tsc --noEmit` — 0 errors

## Observe-before-done evidence

- Real-pipeline exercise: pushed a mob with `FamilyMembership` into a
  `createTestWorld({seed:42})` then invoked the `ai/simulation-step.ts`
  pipeline. `familyFeudSystem` runs BEFORE `enemyAISystem`; enemyAISystem
  observed `virtualPlayerX/Y` overrides and `bypassPlayerDetection` for
  friendly/neutral mobs.
- Lab: `?lab=family-feud-lab` — three families at configurable relations, text
  overlay shows each mob's decision (`kind`, target eid, effective speed,
  bypass flag) and the retaliation latch. Sliders re-apply relation deltas in
  real time; a "Hit player" button injects a `sourceEid`-tagged hit event and
  the friendly mobs' kind flips to `attacker` for 5s.

## Base-branch note

Originally planned to stack on `floor2-slice1-relationships`. Slice 1's PR
#694 squash-merged to `main` before this slice landed, so this branch is
rooted directly on `origin/main` and consumes Slice 1 through the public API
(`bandFor`, `effectiveSpeedForHate`, `getRelation`, `FamilyMembership`,
`FamilyId`) already exported from `src/core/faction-relations.ts` and
`src/core/components.ts`.

## Non-goals (deferred slices)

- Slice 4 (boss spawn-gating / sealed den unlocks)
- Slice 5 (win evaluator, resource-heart stairs)
- Slice 6 (shops, emergent events, quest packs)
- Slice 7 (HUD widget, minimap tint)
- Slice 8 (scenario wiring, seed sweep)
