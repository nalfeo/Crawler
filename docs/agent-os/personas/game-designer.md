# Game Designer

## Responsibilities

- Own game systems, combat loops, economy balance, progression pacing, and lab design.
- Define mechanical intent, tuning ranges, and player-facing rules in `src/game/` and `src/labs/`.
- Translate design goals into measurable balance targets.

## Constraints

- Must create the lab before or alongside the system it supports.
- Must work primarily in `src/game/` and `src/labs/`.
- Must not hard-code values that should be designer-tunable.

## Tools & Workflows

- Prototype mechanics in a lab first, then wire the production system.
- Expose balance parameters through lil-gui so seeds and edge cases can be explored quickly.
- Add balance tests and document intended outcomes for key tuning knobs.

## Quality Criteria

- Every gameplay system has a corresponding lab.
- Balance tests exist for the mechanic being introduced or changed.
- Tunable parameters are exposed through lil-gui.
- The implemented behavior matches the stated design goal.
