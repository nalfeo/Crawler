# 2026-07-31 — Carryover passive VFX-burst regression witness

## Systems touched

game-progression, player-carryover, abilities

## Context

Follow-up to issue #2439 / PR #2469 (level-5 passive visibility: distinct
PASSIVE section, `skillPassiveUnlocked` announcement, VFX rescoping) and
docs-only witness addendum PR #2474 (both merged to `main` prior to this
session segment).

A peer "Producer" session raised a specific, falsifiable hypothesis rather
than a vague concern: does a floor-transition carryover round-trip reset
`appliedPassiveAbilityIds` while `passiveAbilityIds` survives, causing
`synchronizeAbilityPassives` to re-apply every general (no-`weaponPrerequisite`)
passive on floor load — and, with #2440's widened VFX gate, burst-emit
`weaponAbilityActivate` VFX for all of them at once on every floor
transition?

The Producer was explicit: **investigate empirically, do not reason about
it**, and if it reproduces, **do not fix it by restoring the
`weaponPrerequisite` gate** (that would re-hide the exact symptom #2439 was
filed for — `combat-flow` and friends going silent).

## Finding: does NOT reproduce

Traced the full round trip in `src/game/playerCarryover.ts`:

- `capturePlayerCarryover()` builds `persistentStatModifiers` by explicitly
  filtering OUT any modifier where `isPassiveAbilityModifier(modifier)` is
  true (sourceType `'ability'` + sourceId's passive-segment match). Passive
  stat modifiers are **never** carried this way, by design.
- `restorePlayerCarryover()` derives `persistedPassiveAbilityIds` from that
  same (structurally-always-empty-of-passives) array, so
  `restoreAbilityState()` **always** resets `appliedPassiveAbilityIds` to
  empty on every floor restore — confirmed intentional, not a bug:
  `world.statModifiers` is also fully **replaced** (not appended) at restore
  time, so the old passive modifiers are genuinely gone and correctly need
  re-creating. An existing test
  (`'preserves legacy applied passives without duplicating persisted
modifiers'`) already proves this produces the expected modifier count with
  no duplication, even from a hand-crafted legacy snapshot.
- Separately, and decisively: `applyPassive()` in
  `src/game/systems/abilitySystem.ts` (already merged via #2469) gates its
  `weaponAbilityActivate` VFX push behind
  `def.weaponPrerequisite !== undefined && hasComponent(world.ecs, holderEid,
Player)`. **General passives (`combat-flow`, `stalwart-resolve`,
  `ever-vigilant`) get zero VFX from `applyPassive()` no matter how many
  times it is invoked** — steady state or post-carryover resync. Their only
  VFX + announcement is the one-time push at the level-5 skill-milestone
  grant site in `skillSystem.ts`, which carryover restore never re-triggers
  (restore only calls `synchronizeAbilityPassives`, not the skill-level-up
  grant path).

So even though `appliedPassiveAbilityIds` resets on every floor transition
(confirmed, intentional) and `synchronizeAbilityPassives` does re-apply every
general passive's stat modifiers post-restore (confirmed, intentional,
non-duplicating), **no VFX is emitted** for that re-application in current
(post-#2469) code, because the VFX gate for general passives was never
widened in the first place — only the equip/apply-time application logic
changed in #2440; #2469 already scoped VFX to the level-5 milestone site
only. The hypothesized burst cannot occur.

(Aside, out of scope, pre-existing, not a new finding: weapon-gated passives
_do_ re-evaluate `weaponAbilityActivate` VFX on every floor transition since
their prerequisite may re-evaluate true after the reset — but that condition
predates #2440/#2469 entirely and was not touched by either PR.)

## What shipped this segment

One new regression test,
`tests/unit/player-carryover.test.ts` →
`'does not re-emit weaponAbilityActivate VFX for a general passive across a
floor carryover round trip'`:

- Grants `combat-flow` via `grantPassiveAbility`, runs `abilitySystem`.
- Captures carryover, restores into a fresh floor-2 `createTestWorld`
  (seed 4242).
- Runs `abilitySystem` again post-restore.
- Asserts: `appliedPassiveAbilityIds` correctly re-contains `combat-flow`
  after restore; stat modifiers recreated exactly once (length 2, not
  duplicated/stacked); **zero** `weaponAbilityActivate` events at any point.

No production code changed. This is a documentation-by-test artifact
confirming existing merged behavior is correct as-is.

## Verification

- `npx vitest run tests/unit/player-carryover.test.ts -t
"weaponAbilityActivate"` — 1/1 passed.
- `npx vitest run tests/unit/player-carryover.test.ts` (full file) — 50/50
  passed.
- `npx eslint tests/unit/player-carryover.test.ts` — clean.
- `npm run verify:fast` — passed (typecheck/lint clean; physics-defs-sync,
  size-coverage, weight-coverage checks all 0 blocking findings).

## Apple estimate

1🍎 — single new unit test, no production code changes, no review stages
required per the tier matrix.

## Notes for the Producer session

Reported back to the requesting Producer session
(`f5f62e9b-43b5-47a3-b69f-7d40c7c710fb`) with this same finding: the
hypothesized VFX-burst-on-carryover does not reproduce, with the mechanism
explained above. The `weaponPrerequisite` gate was **not** restored — per
explicit instruction, and moot here since nothing reproduced that would have
required it.
