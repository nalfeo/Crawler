# ADR: Floor skips seed direct-start player baselines

## Status

Accepted

## Date

2026-09-06

## Estimated Complexity

🍎 x 2 — manifest data/schema plus scenario initialization wiring; one small
core damage guard was added for a zero-damage regression exposed by the tests.

## Context

Directly starting a later floor through the runner or scene options could create
a player with little or no accumulated progression. That made skipped-floor
balance unrepresentative of normal play, where the player would already have
levels, weapon skill, utility skill progress, abilities, and equipment.

Carryover snapshots are still the authoritative normal floor-transition path,
so the baseline must apply only to no-carryover direct starts.

## Decision

- Add optional `player.directStart` fields to floor manifests for authored
  level, starter weapon skill level, additional skill levels, and fixed static
  equipment ids.
- Route Floor 2-6 no-carryover scenario initialization through
  `applyFloorSkipBaseline`.
- Seed skill levels through the existing skill system so ability milestone grants
  and passives stay on the production path.
- Preserve explicit `playerCarryover` snapshots and never replace them with the
  direct-start baseline.
- Keep zero-damage contact/projectiles as zero damage before armor reduction so
  objective-only actors can remain non-damaging in collision tests.

## Consequences

### Positive

- Direct floor starts now have representative player progression instead of
  starting underpowered.
- Baselines are authored in floor data, so later tuning does not require
  scenario-specific code.
- The same scenario wiring is used by headless and visual floor entry points.

### Negative

- Baseline values are first-pass authored numbers, not broad sweep-tuned values.

### Risks

- Overly high baseline levels can bypass floor-local progression gates. Floor 3
  is intentionally below the final studio unlock threshold to preserve staged
  roster unlocks.

## Alternatives Considered

- **Only change the headless runner default level.** Rejected because visual scene
  options and other direct scenario starts would remain underpowered.
- **Duplicate per-floor scenario code.** Rejected because Floor 2 already had a
  partial bespoke path and additional copies would drift.
- **Apply baselines on top of carryover.** Rejected because it would overwrite or
  inflate real player progression from normal floor transitions.
