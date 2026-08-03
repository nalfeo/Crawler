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

---

## 2026-07-03 — PR Shepherd correction pass (PR #701)

**Persona:** Producer · **Apple estimate:** 🍎🍎🍎 (3) · **ADR added:** `0042-durable-player-hit-signal-for-ally-defend.md`

Took over the idle cloud-authored PR to (a) rebase onto latest `main` (Floor 2
Slices 1/2/4/6 + sprite-cache had advanced it) and (b) resolve all 6 unresolved
`copilot-pull-request-reviewer` threads on their merits.

### Rebase

Rebased onto `origin/main` (`848445c1`). 3 purely-additive conflicts
(`src/game/index.ts`, `src/game/systems/index.ts`, `src/lab-main.ts`) — kept
both sides (main's emergentEvent/floor2Settlement exports + this branch's
familyFeud exports; all lab entries). `tuning.json` auto-merged. Linear history,
no lockfile change.

### The 6 threads — 2 were REAL runtime bugs

1. **Ally-defend never fired in the real visual game (bug).** `familyFeudSystem`
   (a `preSystems` prepass) read the transient `world.combatEvents` queue, which
   `combatVfx.update` drains to length 0 every rendered frame — so the player-hit
   event from frame N was gone before the prepass read it in frame N+1. Headless
   masked it (never drains). **Fix:** durable `world.lastPlayerHit` signal set at
   the core `applyDamage` choke point; survives the drain; one code path for both
   pipelines. (ADR 0042.)
2. **Retaliation targeted a dead projectile, not the shooter (bug).**
   `spawnEnemyProjectile` never attached `Owner`, so `applyEnemyProjectileHit`
   recorded the transient projectile eid as the attacker. **Fix:** threaded
   `ownerEid` through `spawnEnemyProjectile` so the firing enemy is recorded.
3. **Slow-precedence.** `getEnemySpeed` now folds the hate ramp into the base
   speed first, then composes status effects on top — a slowed hate mob stays
   slowed (matches the comment + ADR status-effect composition model).
4. **Rival-fallback consistency.** Dropped the `familyDecision === undefined`
   guard so a ramped hate mob falls back to a rival when the player is
   unreachable, same as a non-ramped hate mob (safe: `!familyBypass` already
   implies `bypassPlayerDetection:false`).
5. **Docstring (feud):** corrected — rival tie-break is by lower eid, not RNG.
6. **Docstring (band-targeting test):** corrected to prepass-scoped, AND
   strengthened with a real `familyFeudSystem → enemyAISystem → movementSystem`
   end-to-end test asserting the neutral mob steers toward its rival.

### Observe-before-done (rule #10) — the key proof

Because headless masks bug #1, the proof is a **deterministic frame-loop-drain
test**: `tests/ecs/enemyAISystem.ally-defend.test.ts` spawns player + friendly
ally (FAM_A) + shooter (FAM_B), fires an enemy projectile owned by the shooter,
runs `collisionSystem` + `damageSystem`, asserts `world.lastPlayerHit.attackerEid
=== shooter`, then **drains `world.combatEvents.length = 0`** (reproducing
`combatVfx.update`), advances a frame, runs `familyFeudSystem`, and asserts the
ally's decision is `kind:'attacker'` with `targetEid === shooter`. Pre-fix this
fails (the drained queue yields no retaliation); post-fix it passes — proving
ally-defend fires in the real frame loop and targets the shooter.

### Verification

- `VERIFY_FULL=1 npm run verify` — **PASS** incl. headless Floor-1 completion
  gate (Step 8: 32 tests) → win-rate target held. Floor 1 has no
  `FamilyMembership` mobs so `getEnemySpeed` is byte-identical there.
- `npm run verify` (build + all non-headless gates + pr-prereqs) — **PASS**.
- Unit 3373 / integration 77 pass; `check:wired-systems` PASS; ledger valid
  (3-apple: plan_review + code_review, round 2 documents these fixes).
- Touched tests: `enemyAISystem.ally-defend` (4), `enemy-ranged-shooting`
  (+shooter/Owner), `enemyAISystem.band-targeting` (8, incl. e2e).
