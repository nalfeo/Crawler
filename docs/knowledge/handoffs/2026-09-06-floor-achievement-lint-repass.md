# Floor achievement lint repass

## Systems touched

floor-epic-planning

## Verdict

Recommended, 2🍎. The repass findings were deterministic contract gaps rather
than gameplay changes.

## Changes

- Expanded achievement threshold detection to cover numeric metric wording such
  as `after 25 kills`, while retaining explicit `threshold` detection.
- Kept unlock, claim, and reward evidence as separate required signals.
- Added a regression fixture for ordinary numeric threshold wording.
- Added exactly-one-owner and unlock/claim acceptance evidence to the existing
  Floor 4, Floor 5, and Floor 6 achievement slices.
- Added the explicit Playtester/Game Designer HUMAN_GATE for Floor 5
  achievement thresholds.

## Evidence

- `npm test -- --run tests/unit/agent/floor-epic-lint.test.ts`
- `npm run typecheck`
- `npm run format:check -- scripts/agent/epics/floor-epic-lint.ts tests/unit/agent/floor-epic-lint.test.ts`

The focused lint suite passes with 41 tests. Canonical legacy floor epics still
contain pre-existing generic floor-factory contract violations unrelated to this
repass; the achievement-specific violations addressed here are no longer
reported for the existing achievement slices.
