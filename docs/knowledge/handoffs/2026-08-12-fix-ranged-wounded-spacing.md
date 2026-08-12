# Session Handoff: Wounded ranged engagement spacing

## Date

2026-08-12

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact).

## What Was Done

Fixed the ranged retreat/engage failure class from weapon sweep run `29453994290`
at SHA `9ef7730f3cd742c7719823262b5243d5464a73e9`.

- Healthy projectile spacing remains 6 ft. Wounded spacing is now 30% of weapon
  reach, clamped to 10–14 ft and never below the healthy orbit.
- Pressure entry and hysteresis derive from the defensive orbit, preventing a
  wounded unit from releasing retreat and closing immediately back to 6 ft.
- Weapon stats, hunt targeting, and boss lock-in are unchanged.
- Tests cover reach scaling and multi-threat pressure-latch behavior.

## Real-pipeline evidence

The exact-SHA baseline used the real headless weapon-sweep pipeline with personas
disabled to match the historical run. `bow-54`, `bow-91`, `pistol-23`,
`throwing-knife-14`, and `throwing-knife-18` timed out at 330 s; `pistol-30`
died at 54.1 s and `throwing-knife-2` at 69.1 s.

After the fix, all seven cases completed Floor 1:

| Cases                                                        | Result        | Game time                 |
| ------------------------------------------------------------ | ------------- | ------------------------- |
| `bow-54`, `bow-91`                                           | 2/2 victories | 248.1 s, 241.2 s          |
| `pistol-23`, `pistol-30`                                     | 2/2 victories | 240.6 s, 242.9 s          |
| `throwing-knife-2`, `throwing-knife-14`, `throwing-knife-18` | 3/3 victories | 240.2 s, 260.7 s, 241.9 s |

Each weapon batch was rerun and its `allRecords` payload matched byte-for-byte,
confirming seed determinism in the real `headless-runner` pipeline.

## Key Decisions Made

- Plan review rejected uncapped 50%-of-reach spacing as potentially
  balance-changing. The bounded 30% / 10–14 ft policy is defensive and low-health-only.
- Pressure derives from defensive orbit plus the existing approach buffer.
- The regression covers the class invariant, not the reported seeds.

## Validation

- `tests/game/behavior-tree-ai.test.ts`: 114 tests passed.
- `npm run verify:fast`: 26 files, 546 tests plus integrity checks passed.
- `npm run check:wired-systems`: no blockers.
- Separate-model code review: clean in round 1.
