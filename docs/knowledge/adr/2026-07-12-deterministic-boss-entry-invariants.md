# ADR: Deterministic Floor 1 Boss-Entry Invariants

## Status

Accepted

## Date

2026-07-12

## Estimated Complexity

🍎 x 4 — coordinates map generation, boss encounter placement, behavior-tree
lifecycle, and real-headless balance gates.

## Context

Four representative Floor 1 failures reached the final boss room with healthy
players, then died immediately after lock-in. Seed 8's declared 17x17 staircase
boss room contained only one passable interior tile. The existing boss resolver
sampled near the room center without considering the live player or declared
doors, and cached pre-encounter AI decisions could survive activation until the
next normal cadence poll.

Placement-only and encounter-opening movement experiments could not make
unreachable arena space usable. The defect crossed the map-generation,
boss-room, and behavior-tree boundaries: generation had to guarantee legal arena
geometry, encounter placement had to use that geometry safely, and encounter
activation had to invalidate observations made before the hostile threat
existed.

## Decision

1. `ensureRoomsReachable()` guarantees every `BOSS_STAIR` room a deterministic
   5x5 passable arena window, or the largest bounded interior for smaller
   rooms, plus fixed horizontal-then-vertical paths from each declared door to
   that window's center. The same helper repairs the dynamically selected Slime
   Rat encounter room after objective selection and special-room sealing, so
   load-bearing doors added by sealing are included. Repair uses fixed
   iteration order and no RNG, chooses the 5x5 window with the most existing
   floor, uses center proximity only as a tiebreaker, preserves the selected
   room's floor terrain, and is byte-identical when an arena already connects
   to every door through passable interior.
2. Both live-entry Floor 1 bosses use one deterministic exhaustive placement
   selector. Candidates must be structurally passable, contained by the exact
   room, reachable from the live player with declared doors blocked, and not a
   door tile. The selector maximizes the minimum Euclidean distance to the player
   and nearest declared door, prefers at least 8 ft, and otherwise returns the
   safest legal fallback. Ties use center proximity and then row-major order.
   If the live player occupies a passable perimeter entry or declared doorway
   on the activation frame, that tile is admitted only as the flood origin; it
   remains excluded from boss candidates and cannot connect traversal through
   other sealed doors.
3. Structural reachability deliberately ignores dynamic barrier overlays.
   Barriers are transient state and can mark the player's occupied flood origin
   as blocked; treating them as room connectivity can crash encounter
   activation. Barrier-aware candidate policy, if later needed, belongs after
   structural reachability.
4. Hostile encounter activation increments a generic monotonic world revision.
   The behavior-tree provider consumes a revision once, clears transient cached
   decision/navigation state, and immediately runs the normal provider at the
   earliest deterministic pipeline-safe poll.
5. Both Floor 1 boss activation predicates require the live player's tile to be
   owned by the target room in `RoomGraph`. Rectangular bounds alone are
   insufficient for irregular rooms because they can include passable tiles
   disconnected from the room's actual interior.
6. Acceptance uses real headless Floor 1 artifacts under the unchanged
   360-second official-win definition. No seed, weapon, boss ID, damage, timer,
   or boss-specific movement branches are permitted.

## Consequences

### Positive

- Malformed boss rooms are repaired at the structural source rather than masked
  by combat behavior.
- Both Floor 1 encounters share deterministic placement and lifecycle
  semantics.
- Safe placement consumes no RNG and is independent of door-close call order.
- Newly spawned hostile encounters cannot inherit stale pre-activation
  decisions, while ordinary frames retain normal polling cadence.
- The four representative seed/weapon configurations become official wins
  without changing the 360-second requirement.

### Negative

- Correcting malformed rooms changes deterministic dungeon goldens.
- Removing placement RNG calls intentionally re-phases later shared RNG draws;
  individual seed outcomes may change even when aggregate performance is stable.
- `GameWorld` now carries an encounter revision that AI providers must reset and
  consume correctly.

### Risks

- Future generators may define boss rooms smaller than the preferred arena; the
  bounded repair and maximum-safety fallback preserve legality but cannot invent
  unavailable distance.
- A future dynamic obstacle policy could conflict with structural placement if
  it is incorrectly folded back into the connectivity flood.
- Geometry changes can alter aggregate balance, so acceptance records the
  maintainer-approved targeted cloud panel for the previously failing geometry
  seeds 7, 12, 25, and 69 across all six weapons and must retain 24/24
  official wins under the unchanged 360-second rule.

## Alternatives Considered

- **Boss-specific health retreat or contact escape:** rejected because it masks
  malformed geometry, risks melee timeouts, and introduces a final-boss special
  case.
- **Temporary contact grace or damage/stat tuning:** rejected because it changes
  combat balance without making the arena navigable.
- **Random or rejection-sampled safe spawn:** rejected because it remains
  arbitrary, consumes variable RNG, and cannot solve a one-tile reachable
  component.
- **Placement-only correction:** rejected after exhaustive placement still had
  only the occupied tile available in seed 8.
- **Encounter-opening spacing behavior:** removed after a bounded experiment
  improved only one of four configurations and diagnostics showed retreat
  targets were structurally unreachable.
