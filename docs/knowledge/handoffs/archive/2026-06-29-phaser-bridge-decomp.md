# Session Handoff: PhaserBridge module decomposition

## Date

2026-06-29

## Persona(s) adopted

**Refactor lens** (primary) with an **Engine** lens. The deliverable is a
behavior-preserving decomposition of an engine module — no feature work, no
gameplay change — so the Refactor discipline (preserve the public surface, prove
equivalence with the existing guards) drove every decision.

## Routing verdict

✅ right persona — "split a god-module without changing behavior, keep all guards
green" is squarely Refactor/Engine. No Producer coordination needed beyond the
disjoint-file ownership already negotiated with the parallel MainGameScene
session.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — new focused modules (2) + a unit suite, 3 source/test files
touched, behavior-preserving, single `src/engine` layer ⇒ no ADR. Landed exactly
at the predicted medium size with no surprises.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Behavior-preserving decomposition of `src/engine/PhaserBridge.ts` (the
~1480-LOC module whose public entry is the `createPhaserBridge(scene)` factory
returning `{ sync, destroy }`). **No production behavior changed** — the full
suite, both pre-existing guard suites, and the headless Floor 1 win-rate gate
are all green. `PhaserBridge.ts` shrank from ~1480 → 1064 LOC (35 insertions,
454 deletions on the tracked file).

### 1. Texture generation → `src/engine/phaser-bridge/textures.ts`

- Moved the entire procedural texture block (`generateTextures` + every `bake*`
  helper + the 21 `TEX_*` keys + the internal welcome-sign dimensions) verbatim
  into a new module. Exports the 21 `TEX_*` keys + `generateTextures(scene)`.
- Kept the logger namespace `engine:phaser-bridge` identical so the
  "Generated procedural fallback textures" log line is byte-identical.
- The facade imports `generateTextures` + the `TEX_*` keys it still needs for
  `getProceduralTextureForType` / `resolveTexture` — call sites unchanged.

### 2. Entity → render-kind dispatch → `src/engine/phaser-bridge/sprite-kind.ts`

Extracted **three pure functions**, structurally typed on only the slices of
`GameWorld` they read (a full `GameWorld` is assignable, so the facade passes its
world as-is):

- `resolveRenderKind(world, eid)` — the `hasComponent` dispatcher (formerly the
  private `getEntityType`). First-match-wins ordering is preserved exactly,
  including the `AreaDamage`→`aoe`/`enemy_aoe` team split, the
  `AoeOnImpact`→`aoe_proj`/`enemy_aoe_proj` projectile split, and the
  `welcome_sign` last-resort (`Sprite` + `textureId === 3`).
- `enemyVariantFromTextureId(textureId)` — the `1→enemy_rat / 2→enemy_slime /
else enemy` mapping. This also **de-duplicated** an inline ternary in `sync()`
  (the live enemy `visualType` refinement now calls the shared helper, identical
  output) alongside its existing corpse-shatter use.
- `computeEnemyScale(world, eid, baseScale)` — the live enemy render scale
  (baby-slime shrink + spawn-in pop/wiggle), a pure mirror of the former
  `applyEnemyScale`. The facade now does
  `const { scaleX, scaleY } = computeEnemyScale(...); img.setScale(scaleX, scaleY);`
  at the single call site.

**Interpretation note:** the task brief described `resolveRenderKind` as "the
hasComponent chain + the textureId→name mapping" but also listed slime-mini /
SpawnAnim cases, which are _scale_ concerns, not _kind_ concerns. Rather than
overload one function, I split along single-responsibility lines into the three
pure functions above. Every concrete branch the brief enumerated is covered, and
the facade wiring is cleaner for it.

### 3. Facade unchanged

`createPhaserBridge(scene)` still returns `{ sync, destroy }` with a
byte-identical public surface. The per-frame `sync()` reconciliation and the
`destroy()` teardown stay in the facade and now delegate to the pure helpers.
The **UNGUARDED `sync()`-after-`destroy()` rebuild path** that session E flagged
was **not touched** — its behavior is preserved.

### 4. New unit coverage — `tests/unit/phaser-bridge-sprite-kind.test.ts`

39 tests, all via `createTestWorld()` (seed 42) + `set()` (which fires the same
`onSet` observers production uses, so the tests read exactly what `sync()`
reads):

- Every `resolveRenderKind` branch: player / npc / harvestable / enemy / gem /
  gold / beam / melee_swing / trap / aoe / enemy_aoe / returning / aoe_proj /
  enemy_aoe_proj / enemy_proj / proj / welcome_sign / default, plus the
  team-split (ENEMY vs PLAYER vs NEUTRAL) and projectile-split sub-branches, plus
  four dispatch-ordering (precedence) locks.
- `enemyVariantFromTextureId` for 1 / 2 / 0 / 3 / 99 / undefined.
- `computeEnemyScale` baseline, slime-mini at 0.65, the 0.2 lower clamp, the 1.0
  upper clamp, the SpawnAnim pop (with a non-vacuous guard), and the
  slime-mini × SpawnAnim multiplicative composition.

## Files Changed

- `src/engine/PhaserBridge.ts` — modified (facade; -419 net LOC, imports/​call
  sites rewired to the new modules).
- `src/engine/phaser-bridge/textures.ts` — **new** (procedural textures).
- `src/engine/phaser-bridge/sprite-kind.ts` — **new** (3 pure render-kind/scale
  helpers + `RenderKindWorld` / `EnemyScaleWorld` structural types).
- `tests/unit/phaser-bridge-sprite-kind.test.ts` — **new** (39 tests).
- `docs/knowledge/metrics/apples/2026-06-29-phaser-bridge-decomp.json` — **new**.

## Verify Results

`npm run verify` — ✅ **PASS** (all 8 steps):

- Typecheck + Lint + Format — green.
- Unit: **237 files / 2713 tests passed** (incl. the 39 new sprite-kind tests,
  the pre-existing 19-test `phaser-bridge.test.ts`, and session E's 6-test
  `phaser-bridge-characterization.test.ts` — both guard suites green).
- Integration: 49 passed / 1 skipped.
- **Headless Floor 1 completion gate: 17 tests passed** — the behavior proof
  that the decomposition preserved gameplay (win-rate gate green).
- Build: ✅.

`bash scripts/agent/lab-gate-check.sh` — ✅ pass (no new ECS system introduced).

## Hard-Rules Compliance

- ✅ Behavior-preserving public surface — `{ sync, destroy }` byte-identical;
  all importers unchanged.
- ✅ Session E's guards + the pre-existing 19-test suite both green; the
  UNGUARDED `sync()`-after-`destroy()` path was not modified.
- ✅ No `Math.random` / `Date.now` introduced (the helpers are pure; randomness
  remains `SeededRandom` upstream).
- ✅ Single `src/engine` layer ⇒ no ADR.
- ✅ Deterministic checks only; no requirement weakened, no seeds cherry-picked.
- ✅ Disjoint ownership respected — did **not** touch `MainGameScene.ts`,
  `src/labs/main-scene-probe-lab/`, `src/lab-main.ts`, `src/core/map/*`, or
  `tests/e2e/main-game-scene-*`.

## Follow-ups / Next Steps

The facade is still ~1064 LOC and has clear further-extraction seams for a future
behavior-preserving pass (all currently characterization-guarded):

- The texture-**resolution** block (`resolveTexture` +
  `getProceduralTextureForType` + the `ENTITY_*_SPRITE` / `*_SCALE` lookup maps)
  could move into a `texture-resolve.ts` sibling.
- The VFX wiring (combat / gore / corpse-shatter / effects) is a cohesive cluster
  that could be grouped behind a small `vfx.ts` facade.
- The per-entity-type `sync()` styling switch is the largest remaining block and
  the most valuable next target, but also the riskiest — extract only behind
  additional characterization guards.

No blockers. Branch: `nalfeo-phaser-bridge-decomp`.
