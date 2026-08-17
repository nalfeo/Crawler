# Session Handoff: Floor 3 slice 2 — damage multiplier hook

## Date

2026-08-17

## Persona

Producer → Systems Engineer (core damage pipeline)

## Systems touched

enemies

## Apples

2🍎 exact

## What Was Done

Implemented **slice 2 of the Floor 3 epic** (`.specify/specs/floor3-companion-league.md`
§Epic decomposition) — the `AFFINITY_MATRIX` damage-multiplier hook in the `apply-damage`
choke point. This is a pure hook only; no `Companion`/`PartySlot` component exists yet
(slice 3), so nothing calls it in the real pipeline yet and there is no runtime/visual
behavior to observe (rule #9 applies starting slice 3, when the first Floor-3 `*System`
lands and actually populates these options).

- `src/core/apply-damage.ts` — added `attackerTemperament?: Affinity` /
  `defenderTemperament?: Affinity` to `DamageOptions` (named "Temperament" — the in-fiction
  name — to avoid clashing with the pre-existing `affinity: DamageAffinity` field, an
  unrelated STR/INT typed-primary concept), and applies `affinityMultiplier()` to
  `finalAmount` right before the health/`dealt` computation whenever **both** fields are
  supplied. Fail-closed: every existing damage path passes neither field, so this is a total
  no-op everywhere except a future Floor-3 companion-vs-companion call site. It composes with
  (doesn't replace) any player-sourced typed-primary/crit scaling that ran earlier in the
  function, since Floor 3 damage is companion-sourced, not player-sourced (R1).
- `tests/unit/floor3-damage-affinity-hook.test.ts` — 6 tests: no-op with neither/only-one
  Temperament supplied, x2 super-effective, x0.5 resisted, x1 neutral, and composition with
  player-sourced scaling via a real `applyDamage` call.

`npm run typecheck`, `eslint`, `prettier`, and `scripts/agent/verify-fast.sh` are green (2259
tests, up from a 2253-test baseline + 6 new tests in this session).

## Key Decisions Made

- **Named the new fields `attackerTemperament`/`defenderTemperament`, not `attackerAffinity`/
  `defenderAffinity`.** `DamageOptions` already has an unrelated `affinity: DamageAffinity`
  field (STR-physical/INT-magic typed-primary scaling). Reusing "affinity" for the Floor 3
  Temperament concept would have been a same-name, different-meaning trap for the next
  reader; "Temperament" is the in-fiction name from the game-design doc, so it reads
  correctly and is unambiguous.
- **Caller-supplied fields on `DamageOptions`, not a new ECS component.** Slice 3 hasn't
  landed the `Companion` component yet, so there's nothing to read a live per-entity
  Temperament from. Following the existing `DamageOptions` extensibility pattern (many
  optional fields already) keeps this slice a pure, testable hook; slice 3's ally-AI/combat
  call site will populate both fields when a companion hits another companion.
- **Applied after the player-sourced scaling block, not folded into it.** The two are
  logically independent (player-origin scaling vs. companion-vs-companion combat) and will
  likely never co-occur in real play, but composing multiplicatively at the end is strictly
  more correct than picking one branch to own the multiplier.

## What's Next / Blockers

Next slice per the spec is **slice 3 — `Companion`/`PartySlot` components + ally-AI
generalization** (deps: slice 1, now landed). That slice is the first to introduce a real
`*System`/component, so it must be wired into a real pipeline per ADR 0039/rule #14, and is
the first slice where this multiplier hook actually fires in a live call site — validate the
hook end-to-end there (real `applyDamage` call with both Temperament fields populated from
live `Companion` components), not just in isolation as done here. No blockers.

## Retrospective

### Lessons Learned

- `apply-damage.ts`'s `DamageOptions` is deliberately additive — every existing optional field
  documents its own fail-closed default in a docstring. Adding two more fields following that
  exact convention (doc comment stating the no-op condition) kept the diff reviewable without
  touching any existing call site.
- `magic-scaling-parity.test.ts` was the right template for exercising `applyDamage` directly
  against a spawned enemy without going through a full system — much faster than standing up
  scene/system scaffolding for a two-field pure-hook test.

### Mistakes Made

- None this session — the change was small and scoped enough that no rework was needed.

### Opportunities for Future Improvement

- Once slice 3 lands the `Companion` component, consider whether `attackerTemperament`/
  `defenderTemperament` should be derived automatically inside `applyDamage` from
  `world.stores`-resident Temperament data (keyed by `sourceEid`/`target`) rather than
  caller-supplied, to remove the risk of a Floor-3 call site forgetting to populate them.
  Deferred here since there's no component yet to derive from.
