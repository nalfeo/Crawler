---
title: 'Floor achievement contract repass'
date: 2026-09-06
---

## Systems touched

floor-epic-planning, achievement-contract QA, agent tooling

## Outcome

Closed the review gaps for issue #4383. The three previously invalid canonical
epics (Floor 3 AI Runner, Floor 3 Companion League, and Floor 4 playable
completion) now satisfy the floor contract with explicit metadata, specialist
owners, one achievement-integrated QA slice, direct prerequisite mechanics, and
release/MVP evidence. Existing duplicate-slice and unrelated-dependency
fixtures remain deterministic regressions in the floor lint unit suite.

## Evidence

- `npm run epics:lint-floor -- <each canonical epic>`: all six canonical epics pass.
- `npm run test:unit -- tests/unit/agent/floor-epic-lint.test.ts --reporter=dot`: 53 tests pass.
- `npm run typecheck`: pass.
- `npx eslint scripts/agent/epics/floor-epic-lint.ts tests/unit/agent/floor-epic-lint.test.ts --max-warnings 0`: pass.
- `bash scripts/agent/verify-fast.sh`: pass.
