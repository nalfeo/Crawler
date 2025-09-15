# ADR: Floor 2 Hunt Progression and Territory Overlays

## Status

Accepted

## Date

2026-07-15

## Estimated Complexity

🍎 x 5 - coordinates deterministic AI objectives, combat eligibility, spawning,
progression telemetry, and minimap rendering

## Context

The production headless runner could complete Floor 2's settlement objective but
then camped or looped instead of earning family den unlocks. It also considered
sealed, invincible family bosses as combat targets before their encounters had
started. The failure was not missing player attribution: family deaths credited to
the player were counted correctly, while most other kills were neutral trash or
director pruning.

Floor 2 also lacked an in-game way to see where family territories overlap, making
both player navigation and AI-run interpretation harder. The progression fix spans
the behavior-tree runner, production encounter state, spawn composition, weapon
targeting, headless evidence, and both minimap modes.

## Decision

1. Model an incomplete Floor 2 family objective as a persistent hunt. The runner
   commits to one incomplete family, prefers reachable live family trash, patrols
   reachable interior territory cells, and advances deterministic patrol points
   when progress stalls instead of camping a fixed anchor.
2. Treat Floor 2 bosses as combat-eligible only after both their den unlock goal
   and encounter `started` state are true. Apply that invariant consistently to
   behavior-tree engagement and weapon target selection.
3. Preserve combat-event source attribution as the authoritative player-kill
   signal. Headless telemetry consumes those events and separately reports family,
   neutral, and boss outcomes rather than inferring kills from entity-count deltas.
4. Normalize territory spawning to a 75% local-family / 25% neutral mix, including
   overlap cases. Keep the production density target at 5, the 700 ms cadence, the
   three-spawns-per-tick limit, and the 140-enemy global cap.
5. Set each production Thin the Horde den unlock to 50 player-attributed, non-boss
   family kills.
6. Render overlapping territories as stable ordered family-color bands rather than
   blended colors. The fullscreen map caches four pixels per dungeon tile and
   invalidates visited-tile colors when boss-defeat state changes; the docked radar
   renders the same bands in its player-centered window.

## Consequences

### Positive

- A production headless run can complete every family hunt, den, boss encounter,
  and the Floor 2 exit without state injection or combat advantages.
- Sealed bosses cannot distract either locomotion or weapon auto-targeting.
- Spawn and kill telemetry now distinguish attribution from composition and
  director lifecycle effects.
- Territory overlap remains legible without inventing ambiguous blended colors.
- The hunt and overlap behavior are deterministic and covered by unit,
  integration, headless, and visual tests.

### Negative

- The behavior-tree provider owns additional persistent Floor 2 hunt state and
  no-progress recovery logic.
- The fullscreen minimap maintains a cached territory texture and palette
  signature in addition to its existing visited-tile state.
- A 50-kill den threshold replaces the previous 100-kill progression target.

### Risks

- Future combat or weapon paths that bypass the shared boss-eligibility predicate
  could reintroduce pre-encounter boss targeting.
- Future family counts above four would require a higher-resolution overlap
  representation; the current four-pixel tile matches the production maximum.
- The proven run reaches 68.8% hunt combat occupancy, below the earlier 70-80%
  preference. Increasing the nearby target to 12 caused an early death after the
  lower threshold accelerated den progression, so density remains unchanged.

## Alternatives Considered

1. **Fix attribution alone.** Rejected because probes showed family player kills
   were already attributed correctly; most unattributed removals were neutral
   enemies or director pruning.
2. **Camp a fixed territory anchor.** Rejected because closed loops and empty
   local spawn pockets can indefinitely stall progress.
3. **Use global nearest-family targeting.** Rejected because closed den geometry
   and distant territory cells can select unreachable targets.
4. **Blend overlap colors.** Rejected because mixtures resemble unrelated family
   colors and do not identify each contributor.
5. **Raise production density to 12.** Rejected after a controlled run died at
   283.2 seconds with 0.3% minimum health; production density remains 5.
