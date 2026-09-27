# Floor 4 Headliner health

## Date

2026-09-25

## Persona

Producer coordinating Game Designer tuning and QA verification.

## Systems touched

floor4-arena, enemies, ai-combat-balance, headless-runner

## Summary

Issue #4519 exposed that Floor 4 Headliners still used their original raw
130–300 HP values after the merged gear-score and nearby-density work increased
the production automatic-combat build's damage and income. In the canonical
seed-404 production run, the Act 1 Mascot Mauler died in 4.77 seconds, before
its 9.3-second first ability window.

Headliners now have per-candidate authored health values sized for the current
act build curve. `Floor4HeadlinerTelemetry` records each physical encounter's
start and defeat times, and a deterministic production-headless gate derives
the minimum fight time from every selected ability's first-eligible delay plus
telegraph duration. It also preserves the 30-second normal headline window and
requires the canonical run to remain a victory.

## Evidence

- Baseline seed 404: Mascot Mauler duration 4.77s versus required 9.3s.
- Corrected `floor4-headliner-survival-gate`: passed; every selected Headliner
  survived its opening authored mechanic and stayed within 30 seconds.
- `tests/headless/floor4-arena-completion.test.ts`: 2 passed.
- `npm run typecheck`: passed.
- `npm run verify:fast`: passed.
- The Floor 4 MainGameScene deterministic completion test was launched with
  Chromium desktop permission; retain its final result in the PR description.

## Notes

The change preserves automatic combat, deterministic replay, safe-room rules,
phase boundaries, and overtime. No art asset changed.

## CI follow-up

PR #4743 initially failed the mandatory Floor 1 headless job because the
existing Floor 4 nearby-pressure test's seed-2 automatic run died during the
extended third Headliner and never observed Acts 4–5. The durability change
kept the player in contact range longer without compensating the authored
per-act contact-damage curve. The Headliner contact values are reduced in the
same authored manifest so the automatic player reaches every wave window while
the Headliners retain their longer mechanics window. The seed-2 pressure probe
again passes all five 8–12 nearby-enemy assertions.

The replacement run then exposed a deterministic boundary miss: seed 1 Act 4
averaged 7.989 nearby enemies against the 8.0 minimum. Raising the global
refill target would have pushed seed 2 beyond the 12.0 maximum, so the scoped
fix increases only Act 4's scheduled-wave multiplier from 2.40 to 2.42.
The canonical Mascot Mauler also lasted 9.22 seconds after the prior contact
tuning, just short of its 9.30-second opening mechanic; its health is 1,020 so
the production headliner-survival gate observes that mechanic.

After the pre-publication rebase onto current main, the Act 3 Pyro Principal
lasted 8.67 seconds against its 9.90-second opening mechanic. Its health is
850, which restores the authored opening window in the rebased canonical run.

## Recommended next steps

Monitor the replacement CI run for PR #4743; do not auto-merge.
