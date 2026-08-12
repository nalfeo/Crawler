# Session Handoff: Wounded ranged engagement spacing

## Date

2026-08-12

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact) — a localized behavior-tree policy change
with exact-commit reproduction, deterministic headless validation, and review harness.

## What Was Done

Fixed the ranged retreat/engage failure class from weapon sweep run `29453994290`
at SHA `9ef7730f3cd742c7719823262b5243d5464a73e9`.

- Healthy projectile users retain the existing 6 ft engagement orbit.
- Wounded projectile users now derive a defensive orbit from weapon reach:
  30% of reach, clamped to 10–14 ft and never below the healthy orbit.
- Pressure entry and hysteresis derive from that defensive orbit, preventing a
  wounded unit from releasing its retreat latch and immediately closing back to
  the universal 6 ft orbit while nearby threats remain.
- Weapon stats, hunt target selection, and boss arena lock-in logic are unchanged.
- Regression coverage verifies reach scaling and multi-threat pressure-latch behavior.

## Real-pipeline evidence

The exact-SHA baseline used the headless weapon-sweep pipeline with weapon personas
disabled to match the historical run:

- `bow-54`, `bow-91`, `pistol-23`, `throwing-knife-14`, and
  `throwing-knife-18` timed out at 330 s.
- `pistol-30` died at 54.1 s and `throwing-knife-2` died at 69.1 s.

After the fix, the same seven cases completed Floor 1:

| Cases                                                        | Result        | Game time                 |
| ------------------------------------------------------------ | ------------- | ------------------------- |
| `bow-54`, `bow-91`                                           | 2/2 victories | 248.1 s, 241.2 s          |
| `pistol-23`, `pistol-30`                                     | 2/2 victories | 240.6 s, 242.9 s          |
| `throwing-knife-2`, `throwing-knife-14`, `throwing-knife-18` | 3/3 victories | 240.2 s, 260.7 s, 241.9 s |

Each weapon batch was rerun and its `allRecords` payload matched byte-for-byte,
confirming seed determinism in the real `headless-runner` pipeline.

## Key Decisions Made

- The initial uncapped 50%-of-reach proposal was rejected during plan review as
  too large and potentially balance-changing. The bounded 30% / 10–14 ft policy
  keeps the change defensive and local to low-health behavior.
- The pressure threshold is derived from the defensive orbit plus the existing
  approach buffer. This makes the release window coherent with the selected
  weapon's defensive distance instead of hard-coding another universal radius.
- The class-level invariant is covered directly rather than special-casing the
  seven reported seeds.

## Validation

- `tests/game/behavior-tree-ai.test.ts`: 114 tests passed.
- `npm run verify:fast`: 26 files, 546 tests plus integrity checks passed.
- `npm run check:wired-systems`: no blockers.
- Separate-model code review: clean in round 1.

## What's Next / Blockers

No known blockers. The fix is ready for CI and review.
