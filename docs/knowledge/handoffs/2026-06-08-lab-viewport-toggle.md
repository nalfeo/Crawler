# Session Handoff: Lab viewport toggle

## Date

2026-06-08

## What Was Done

- Added a shared **desktop-only lab shell toggle** that clamps active labs into an **iPhone landscape-sized viewport** (`844x390`) so mobile-only rendering issues can be reproduced locally without changing individual labs.
- Moved the existing lab shell button logic out of `lab.html` inline script and into `src/labs/lab-shell.ts`, which now owns:
  - controls panel collapse/expand state
  - viewport preset state
  - localStorage persistence for both
- Updated `lab.html` layout to introduce a stage wrapper and toolbar button, plus the centered framed viewport styling used when the iPhone-landscape preset is enabled.
- Wired `src/lab-main.ts` to initialize the shell before loading either the lab index or a specific lab.

## Tests Added

- `tests/unit/lab-shell.test.ts`
  - verifies controls collapse affordance updates
  - verifies viewport toggle label/class updates
  - verifies persisted state restore + save flow
  - verifies the viewport toggle hides when not allowed

## Validation

- `npx vitest run tests/unit/lab-shell.test.ts --project unit --reporter=verbose`
- `npx tsc --noEmit`
- `npx eslint src/ tests/ scripts/ --max-warnings 0`
- `npx vitest run --project unit --reporter=dot`

## Notes

- `npm run verify:fast` stalled twice while the unit phase was already running, but the underlying typecheck, lint, and full unit suite passed when run directly.
- The viewport toggle only appears for active labs on desktop-class pointers / widths; it is hidden on smaller or coarse-pointer devices.

## Blockers

- None.
