# ADR: Status effects are shown by one shared ground-aura layer, and Curse triggers on its own blast radius

## Status

Accepted

## Date

2026-08-27

## Estimated Complexity

🍎 x 3 — a data-only ability retune plus one new render-side subsystem
(resolver + single-Graphics renderer) wired into the shipped `PhaserBridge`;
no simulation behavior change, no new lab.

## Context

Playtest issue #3690 reported two things about the same fight: Curse's range
felt too low, and an enemy carrying a status effect looked identical to one that
did not. Sibling issue #3677 ("I dont think Curse ever triggered") is the same
bug seen from the other side.

Both halves had a concrete structural cause.

**Curse could not fire near its own blast.** Curse is an `enemy_cluster`
ability: `abilitySystem` counts enemies within `trigger.withinFeet` of the
caster and fires when at least `trigger.minEnemies` are inside that ring. The
authored trigger was `{ minEnemies: 4, withinFeet: 8 }` while the effect it
casts, `spell_enemy_slow_burst`, has `radiusTiles: 4` — and
`applyEnemySlowBurst` converts tiles to feet at `DEFAULT_TILE_SIZE_FT = 4`, so
the burst covers **16 ft**. The trigger ring was half the radius of the thing it
triggers, and it additionally demanded four enemies inside that half-size ring.
The ability was effectively unreachable in normal play, which reads to a player
as "the range is too low".

**Nothing marked an afflicted enemy.** The only cue was a subtle multiply tint
(`0xaadfff`) applied by `PhaserBridge`, and only for `stat === 'speed'` effects.
Every other status — `attackSpeed`, `damage`, `hpRegen`, `defense` — rendered
with no cue whatsoever. There was no shared answer to "what does an afflicted
entity look like", so each future effect would have invented its own.

## Decision

**1. The `enemy_cluster` trigger ring is sized to the ability's own effect.**
Curse becomes `{ minEnemies: 2, withinFeet: 16 }`: the ring now equals the 16 ft
burst, so every enemy that completes the cluster is inside the burst it causes,
and a pair of enemies is enough. `radiusTiles` stays at `4` — widening the blast
as well would have been power creep on top of a reachability fix.

`cooldownFrames` moves 840 → 960 (14s → 16s), following the literal wording of
the issue ("cooldown is too low"). Because the trigger, not the cooldown, was
the binding constraint, Curse still fires far more often in practice than it did
before. This reading is flagged in the PR for the maintainer; the counter-reading
("Curse is available too rarely") is a one-line revert.

**2. Status visuals are resolved once, in one pure place.** A new
`src/engine/status-effect-visuals.ts` maps a live `StatusEffect[]` to at most one
`StatusVisual` (`slow | weakened | wither | haste | empowered | regen`).
Polarity is derived from the `(stat, op, value)` triple rather than from `stat`
alone, so a `speed × 0.4` curse and a `speed × 1.6` haste never share a look, and
no-op specs (`add 0`, `multiply 1`) and expired effects contribute nothing. A
fixed priority list resolves multi-effect entities, so the chosen visual does not
depend on the order effects were applied — required for determinism between the
real scene and any replay.

**3. Every aura is drawn into ONE shared `Graphics`, cleared and redrawn per
rendered frame.** `src/engine/StatusEffectVfx.ts` owns the layer at a new
ground-plane depth `WORLD_VFX_DEPTH.statusAura = -12`. `PhaserBridge` collects
targets during the entity pass it already runs and hands the list over after
`mobAbilityVfx.update(world)`.

## Consequences

### Positive

- Curse is reachable in normal play, and its trigger ring is now derivable from
  its own effect rather than being an independent magic number that can drift.
- Any status effect — present or future — gets a visible treatment for free; new
  effects only pick a `StatusVisual` kind instead of adding a renderer.
- One shared `Graphics` keeps the display list flat at 100+ affected enemies and
  makes bitecs EID recycling a non-issue: there is no per-entity cached object
  that could outlive its entity and re-attach to a recycled EID. This is the
  failure mode a per-entity aura pool would have had.
- The aura reuses the bridge's existing living/visible enemy gate, so it can
  never reveal a fog-hidden enemy nor paint a corpse.

### Negative / risks

- The aura layer is redrawn every rendered frame even when the affected set is
  unchanged. That is a fixed handful of `fillEllipse`/`strokeEllipse` calls per
  affected enemy and was accepted in exchange for having zero per-entity
  lifecycle state; if the affected set ever gets large enough to matter, the fix
  is to skip the redraw when neither the target list nor the pulse bucket moved.
- Curse firing on two enemies instead of four changes the value of the ability in
  the AI equipment-loadout evaluator, which reads `minEnemies` and the cooldown
  dynamically. Seeded headless outcomes can therefore shift; the win-rate gates
  in CI are the check on that.
- The cooldown direction is an interpretation of ambiguous playtest wording, not
  a measured tuning result.

## Alternatives considered

- **Widen the burst instead of the trigger** (`radiusTiles` 4 → 5). Rejected: the
  burst was never the problem, and it would have made a reachability fix into a
  balance buff.
- **Lower the cooldown as well.** Rejected for now — it compounds with a trigger
  that is already far easier to satisfy, and the issue's literal wording asks for
  the opposite. Called out explicitly in the PR instead of being decided silently.
- **One `Graphics` (or particle emitter) per affected entity**, mirroring how
  `MobAbilityVfx` draws its per-entity Tarnished ring. Rejected: it needs a
  create/destroy lifecycle keyed by EID, which is exactly what bitecs entity
  recycling makes hazardous, and it grows the display list with the affected set.
- **Reuse `MobAbilityVfx` for player-sourced statuses.** Rejected: that subsystem
  is scoped to `mob-ability:`-sourced effects and keying it on arbitrary status
  sources would have widened its contract rather than adding a general one.
- **Tint only, no aura.** Rejected: the tint was already there and is what the
  playtest report calls invisible; a multiply tint on an already-dark sprite in a
  torch-lit room does not read.
