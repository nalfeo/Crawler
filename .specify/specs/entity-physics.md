# Spec: Entity Physics (Size & Weight)

> **Status:** Proposed
> **Last reconciled:** 2026-07-04
> **Estimated complexity:** 🍎🍎🍎 — cross-system (collision, knockback, damage, every spawner, every broad-phase consumer); data-table refactor
> **Related ADRs:** 0044-explicit-size-weight-components, 0007-spatial-units-architecture, 0023-feet-as-single-internal-spatial-unit
> **Canonical home:** this spec is the living size/weight contract; ADR
> 0044-explicit-size-weight-components is the decision log behind it.
> **Code source-of-truth:** `src/core/components.ts` (Size + Weight defs + stores), `src/core/physics-defs.ts` (canonical registry, new), `src/core/collision.ts`, `src/core/systems/collisionSystem.ts`, `src/core/systems/knockbackSystem.ts`, `src/core/systems/damageSystem.ts` (`applyPlayerEnemyHit`), `src/core/systems/{meleeSwingSystem,areaDamageSystem,beamSystem,returningProjectileSystem,trapSystem}.ts`, `src/core/spawners/*`
> **Labs:** `src/labs/physics-body-lab/` (new — Slice 1)
> **Test suites:** `tests/unit/core/{collision,knockback,damage}.test.ts`, `tests/headless/floor1-completion.test.ts` (win-rate gate, unchanged), new `tests/unit/core/physics-defs.test.ts`, new `tests/headless/collision-pair-parity.test.ts` (Slice 1 regression gate)
> **Known implementation gaps:** entire feature is greenfield beyond the existing declarative `Weight` component

## Context

The user asked for "a true size and weight system. All entities need to have
a size and weight. Size is actually used for collision (such as when mobs
need to touch player to do damage). Weight is used for things like knockback."

Today (`origin/main` @ c53ff04):

- `Weight` is declared, stored, and populated everywhere, and a few
  non-physics paths read it (`dropSystem.ts:217` derives a split slime's
  child weight; `initializeEnemyAppearance` in `combatants.ts:36` rescales
  it by `sizeScale`) — but no knockback/collision consumer uses it yet.
- Physical size is `sprite.width` × `sprite.height` (a render field) —
  read directly by `collisionSystem.ts` (broad-phase AABB insert) and
  `knockbackSystem.ts` (footprint passability). Any change to sprite scale
  silently changes hitboxes.

Design rationale, alternatives, and consequences: **ADR 0044**.

## Requirements

**R1.** Every entity that participates in the collision grid MUST have an
explicit `Size` (either `radius > 0` or `halfWidth > 0 && halfHeight > 0`).
Enforced by `npm run check:size-coverage`, added to `verify:fast`.

**R2.** Every entity with `Enemy`, `Player`, or `Prop` MUST have `Weight`
with `value > 0` — including `Immovable` entities, whose weight is still
meaningful (e.g. a 10 000 lb wall's weight is exactly what trips
`IMMOVABLE_THRESHOLD`, and the data table assigns weights to every
`Immovable` prop). `Immovable` affects knockback _displacement_ (R5), not
weight _presence_. Enforced by `npm run check:weight-coverage`, added to
`verify:fast`.

**R3.** `collisionSystem` reads half-extents / radius **exclusively** from
`Size` after Slice 1's shim is removed. `sprite.width` / `sprite.height` are
never read outside `src/engine/**` or `src/labs/**` — enforced by an
ESLint `no-restricted-syntax` rule.

**R4.** Mob-touch-player contact damage (`applyPlayerEnemyHit` in
`damageSystem.ts:302`) fires based on `Size` overlap, not sprite overlap.
Same for `Enemy ↔ EnemyProjectile ↔ Player` and every other pair the
`damageSystem` inspects.

**R5.** Knockback displacement per frame ∝ 1 / target `Weight`, clamped at
`KNOCKBACK_WEIGHT_SCALE_MAX = 2.5×`. A 120 lb (median-mob) target sees the
same visible knockback as today for the currently-shipping MELEE_KB /
projectile / area-damage / corpse-explosion constants. A 60 lb target
moves 2× as far; a 240 lb target moves 0.5× as far; ultra-light authored
mobs (rat @ 6 lb, slime @ 20 lb) clamp to 2.5× instead of getting punted
absurd distances. The cap boundary is 48 lb — targets ≥48 lb scale
linearly. A target with `Weight ≥ IMMOVABLE_THRESHOLD` or `Immovable`
sees no displacement.

**R6.** Authored Size / Weight values live with the owning definition
type. For mobs, default size, default weight, and allowed variance ranges
live on the mob definition record beside sprite/stats/AI metadata.
`docs/knowledge/game-design/entity-sizing.md` is the human-readable review
sheet; `src/core/physics-defs.ts` is the composed runtime registry. CI
checks fail on drift between the authored defs, the composed runtime view,
and the review sheet — including missing entries, schema violations, or
mismatched numeric values.
For this spec, a variance range is the authored min/max band around a
mob's default body values; Slice 1 may keep it zero-width (`min = default
= max`) so migration stays parity-safe.

**R7.** Slice-1 landing MUST NOT shift `tests/headless/floor1-completion.test.ts`
win-rate below 90% (per project Rule #13). Slice-2 landing MUST NOT shift
it either — recalibration of knockback constants is allowed to hold this.

**R8.** Slice-1 landing MUST NOT change collision-pair counts per frame by
more than a documented tolerance on a fixed-seed replay
(`tests/headless/collision-pair-parity.test.ts`), because the data-table
values for Slice 1 are set equal to today's shipping sprite dimensions.

## Design

Component + store schema, authored-definition ownership, per-writer
semantic change for weight/knockback, and the shim/coverage gate: see ADR
0044 §Decision.

For mobs specifically, the authored body data lives with the same
definition record that already owns sprite/stats/AI data. Slice 1 should
extend that record with default size, default weight, and allowed variance
ranges, then have the composed runtime registry read from it.

### Slice 1 (Size foundation)

1. Add `Size` component + `size` store.
2. Extend mob definitions with body defaults + variance ranges beside sprite/stats/AI
   metadata, keeping `docs/knowledge/game-design/entity-sizing.md` as the
   review sheet.
3. Add `src/core/physics-defs.ts` composition + `check:physics-defs-sync`
   gate.
4. Route every spawner through the composed registry, with mob spawners
   sourcing their defaults from mob defs.
5. `collisionSystem` reads `Size` first, `Sprite` as legacy shim; log dev
   warning on shim path.
6. `knockbackSystem.isFootprintPassable` reads from `Size`.
7. Add `check:size-coverage` gate + wire into `verify:fast`.
8. Add `src/labs/physics-body-lab/` — renders body outlines vs sprite
   outlines with sliders; lab-gated per Rule #1.
9. Real-pipeline validation per Rule #10 — must observe in `npm run dev`
   (screenshot) AND `tests/headless/collision-pair-parity.test.ts` fixed-seed
   run, not the lab.
10. Burn the shim: once `check:size-coverage` is clean, delete the Sprite
    fallback in `collisionSystem` and `knockbackSystem`. Add ESLint rule
    R3.

### Slice 2 (Weight as knockback denominator)

**Design note (2026-07-05, Slice 2 shipping):** Slice 2 applies the weight
divide **reader-side** in `knockbackSystem`, not per-writer. This was chosen
over the writer-side design originally sketched in ADR 0044 because it
(a) keeps writer constants untouched — no per-writer recalibration risk,
(b) automatically applies weight scaling to any future knockback writer,
and (c) shrinks the audit surface to a single system. See ADR 0044
§Weight as knockback denominator for the amended contract. Writers MUST
keep their knockback speed/duration values in **raw, unscaled** units;
the reader applies `speed * (120 / max(1, weight))` and decrements the
remaining-distance budget by the unscaled base step so that impulse
duration in frames is weight-invariant while only total displacement
scales.

1. Update `knockbackSystem` (single reader) to scale per-frame
   displacement by `120 / max(1, targetWeight)`. Writers
   (`meleeSwingSystem`, `dropSystem` corpse-explosion,
   `progressionEffects`, and any future writer such as
   `applyProjectileHit`, `applyEnemyProjectileHit`,
   `applyPlayerEnemyHit`, `areaDamageSystem`, `beamSystem`,
   `returningProjectileSystem`) keep writing raw knockback values.
2. Add `Immovable` tag + `IMMOVABLE_THRESHOLD` short-circuit in
   `knockbackSystem` — drop the component without moving.
3. Add `check:weight-coverage` gate + wire into `verify:fast`. Gate
   enforces per-kind non-vacuity (Enemy, Player, Prop each > 0) and
   `weight.value > 0` for every knockback-eligible entity.
4. Freeze enemy weight against the cosmetic `sizeScale` RNG in
   `initializeEnemyAppearance` — weight is a first-class gameplay dial
   now, not an appearance attribute.
5. Real-pipeline validation:
   - `tests/headless/floor1-completion.test.ts` win-rate ≥ 90%
   - `scripts/agent/perf/winrate-sweep.ts` seed sweep matching pre-Slice-2
     baseline within ±2%.

## Test Plan

**Unit** (`tests/unit/core/`):

- `physics-defs.test.ts` (new) — every registered def has valid size (r>0
  ∨ hw>0∧hh>0) and weight (>0); IDs match spawner call sites.
- `collision.size.test.ts` (new) — box vs circle vs circle-vs-box narrow
  phase; identity with legacy sprite dims when shim path taken.
- `knockback.weight.test.ts` (new) — 120 lb baseline is identity; 60 lb
  moves 2×; 6 lb (rat) clamps to `KNOCKBACK_WEIGHT_SCALE_MAX = 2.5×`;
  240 lb moves 0.5×; Immovable stays put; walls (in the current
  no-Knockback path) unchanged.
- `apply-damage.contact.test.ts` — mob-touch-player fires only when Size
  overlaps (not sprite bounds).

**Headless** (per Rule #10; lab-only proof is INSUFFICIENT):

- `tests/headless/collision-pair-parity.test.ts` (new, Slice 1 gate) —
  fixed-seed replay over N frames; pair count per frame within tolerance
  of pre-Slice-1 golden.
- `tests/headless/floor1-completion.test.ts` (existing, Rule #13 gate) —
  win-rate must stay ≥ 90% at both Slice 1 and Slice 2 landing.

**E2E** (`tests/e2e/`):

- `tests/e2e/hud-overlap-visual.test.ts` style deterministic pixel probe:
  spawn a fixed heavy vs light mob pair in a controlled room, apply a
  scripted swing, assert the heavy mob's post-swing position moved less
  than the light mob's. Not a lab.

**Real-pipeline artifact** for the handoff (Rule #10):

- Slice 1: `npm run headless -- --seed 42` collision-pair-parity numbers.
- Slice 2: `npm run headless -- --seed 42 --winrate-sweep` win-rate before
  vs after; `npm run dev` recording with debug overlay showing bodies +
  knockback arrows for a light and heavy mob.

## Constitutional Compliance

- **Principle 1 (Lab-gated development):** `src/labs/physics-body-lab/`
  added Slice 1.
- **Principle 6 (Deterministic runtime):** All new logic is pure and reads
  only from stores; no `Math.random()` / `Date.now()`.
- **Principle 10 (Observe before done):** Named real-pipeline artifacts in
  the Test Plan; lab is validation-support only.
- **Principle 13 (Win-rate ≥ 90%):** Both slices gated on Floor 1
  completion test.
- **Principle 14 (Apple-scaled review harness):** 🍎🍎🍎 → dual-plan
  synthesis + multi-model review + code-review loop; review ledger
  authored via the `review-harness` skill before each slice's PR.
- **Principle 15 (Wired-systems check):** No new `*System` exports (Size
  logic lives inside existing `collisionSystem` and `knockbackSystem`), so
  the orphaned-systems gate does not fire. `check:wired-systems` still
  runs and must stay green.

## Docs / index updates required

- `.specify/specs/README.md` — add this spec to the current-specs table.
- `docs/architecture.md` — one-line addition to the ECS component list
  section pointing to this spec.
- `docs/systems/README.md` — no new slug required; changes land under the
  existing `enemies` and `weapons` slugs plus a new dossier under
  `docs/systems/NN-physics.md` (Slice 1 deliverable).
- `docs/knowledge/adr/README.md` — link ADR 0044.
- `docs/knowledge/memory/` — add a durable-fact entry
  "physics.size-and-weight-are-canonical" so future agents don't
  reintroduce `sprite.width` reads.
- Handoff at `docs/knowledge/handoffs/YYYY-MM-DD-size-weight-*.md` per
  slice, with `## Systems touched: enemies, weapons, ai-combat-balance`.
