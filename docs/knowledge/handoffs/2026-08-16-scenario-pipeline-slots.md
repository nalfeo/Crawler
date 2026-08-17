# Session Handoff: Scenario pipeline slots

## Date

2026-08-16

## Persona

Systems Engineer

## Systems touched

enemies, ci-policy

## Apples

4🍎 estimated, 4🍎 actual (🎯 exact)

## What Was Done

- Moved five floor-specific pre-systems from the unconditional bootstrap array
  into three typed `ScenarioDefinition` slots.
- Kept one canonical bootstrap assembler for visual/headless ordering.
- Extended the orphaned-system guard to recognize scenario registrations.
- Added table-driven Floor 1/Floor 2 isolation, exactly-once, and slot-boundary
  coverage plus ADR 0086 and architecture documentation.
- Observed in the real headless pipeline with seed 42 for 600 frames per floor:
  before and after produced the identical combined RunStats fingerprint
  `77273aa96c5df50e6242fa37e46fa46a1cc65d4cd2c4eefa012ff9ee1d6d2118`;
  the canonical arrays changed from three/two foreign systems to zero.

## Key Decisions Made

- Scenario definitions own only floor-local executable references; bootstrap
  retains all shared systems and ordering authority.
- Named slots replace complete per-floor arrays or numeric priorities.
- Exactly-once means membership in the canonical `preSystems` array;
  `floor2ObjectiveTick` retains its post-core victory reevaluation.

## What's Next / Blockers

No known blockers. CI should run the full repository suite after publication.

## Retrospective

### Lessons Learned

Moving runtime references into a registry also moves the witness location used
by the orphaned-system guard; the trusted wiring-site list must change with the
architecture.

### Mistakes Made

The first delegated design review recommended complete per-floor arrays, which
would have duplicated shared ordering. The early signal was the user's explicit
requirement that bootstrap remain the general assembler, so the implementation
retained named slots instead.

### Opportunities for Future Improvement

The architecture overview had stale Floor 1-only pipeline text and an obsolete
bootstrap filename; future pipeline changes should include that page in the
initial documentation search.
