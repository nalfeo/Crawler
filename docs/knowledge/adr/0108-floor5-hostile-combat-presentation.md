# ADR 0108: Floor 5 hostile combat and siege presentation

## Status

Accepted

## Date

2026-09-20

## Estimated Complexity

🍎 x 3 — repairs the existing combat contract and projects siege state through existing rendering seams.

## Context

Floor 5 field Heroes and both teams of minions render as generic enemies, but
they lack the `Enemy` marker consumed by ordinary player weapons. The original
lane-war and Hero implementations deferred this integration to avoid activating
generic AI, contact attacks, and rewards. The floor also lacks a scenario HUD,
and its Ram and structures fall through generic rendering.

PR 1 of the rehabilitation track must make hostile actors damageable by every
starter weapon, protect allied actors, preserve siege objective targets, and
expose live siege state in MainGameScene. Field objectives, wave cadence, Ram
escort rules, and the finale remain separate work.

## Decision

- **DEC-001**: Enemy-team `SiegeMinion` and `SiegeHero` entities also carry
  `Enemy`. Allied minions, structures, and the Ram do not. Explicit siege team
  IDs and markers remain authoritative; no `EnemyBehavior` is added. Existing
  weapon acquisition and hit queries therefore serve the new targets without
  introducing another combatant registry.
- **DEC-002**: Siege systems retain movement, target selection, and attack
  ownership. Generic player contact damage excludes siege minions and Heroes.
  Their deaths produce ordinary visual feedback without new loot, XP, reward
  RNG draws, or corpse lifetime changes. This preserves the earlier floor's
  lifecycle and avoids a balance change as a side effect of targetability.
- **DEC-003**: A renderer-neutral Floor 5 HUD projection uses the existing
  `ScenarioPresentationContract.getHudSnapshot` seam. It reads current phase,
  objective, Command Post health, and Ram state/progress from the authoritative
  world; it does not advance gameplay.
- **DEC-004**: The existing render-kind/texture registry gains procedural siege
  placeholders. Siege markers take precedence over generic `Enemy` rendering.
  Shape and color distinguish ally, hostile, Hero, Ram, and Command Post while
  retaining hostile visibility and death presentation behavior.
- **DEC-005**: Extend the existing MainScene probe lab and Playwright/Vitest
  coverage to exercise actual scene simulation and inspect rendered objects.
  No new simulation framework, targeting library, or visual test framework is
  needed; the existing bitecs and Phaser contracts already provide the seams.

## Consequences

### Positive

- **POS-001**: All starter weapon families share their normal targeting and
  damage path with Floor 5 hostiles.
- **POS-002**: Allies and objective objects remain outside player hostile hit
  queries, and siege-specific targeting does not become generic pursuit AI.
- **POS-003**: Players can read live siege state and identify placeholder roles
  before finished art is available.

### Negative

- **NEG-001**: Generic contact and death consumers need explicit siege ownership
  guards. Future `Enemy` consumers must respect those ownership boundaries.
- **NEG-002**: Procedural art is intentionally temporary and is not a substitute
  for the later Floor 5 asset track.

### Risks

- **RSK-001**: Broad `Enemy` queries may introduce unrelated side effects. Focused
  contact/reward/lifecycle tests and real-scene weapon tests guard this adapter.
- **RSK-002**: Render dispatch ordering can erase siege identity after adding
  `Enemy`; tests must cover actual entities carrying both markers.
- **RSK-003**: HUD copy must describe the current implementation truthfully,
  including scripted progress that later PRs will replace.

## Alternatives Considered

### Replace every weapon query with a new combat allegiance abstraction

- **ALT-001**: Rejected for this bounded repair: it expands risk across all
  floors when the established hostile marker already provides acquisition and
  damage eligibility. Explicit siege teams remain available for a future
  broader allegiance design.

### Add Enemy without preserving siege ownership

- **ALT-002**: Rejected because generic contact damage and reward spawning would
  silently change attacks, cooldowns, rewards, and deterministic RNG consumption.

### Special-case Floor 5 in MainGameScene

- **ALT-003**: Rejected because the existing scenario HUD contract and render
  registry provide floor-neutral seams without crossing engine/game boundaries.
