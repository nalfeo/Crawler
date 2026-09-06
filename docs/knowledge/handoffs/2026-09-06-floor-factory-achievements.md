---
title: Floor Factory achievement planning gate
date: 2026-09-06
persona: Producer
apple_estimate: 2
apple_actual: 2
---

## Systems touched

agent-personas, docs-tooling

## Outcome

Implemented issue #4383 by making achievement work a deterministic Floor
Factory planning requirement. Floor epics now require an achievement or
achievement-integrated QA node with prerequisite dependencies and measurable
unlock/claim or reward acceptance. The achievement-specific lint now also
rejects zero or multiple Owner declarations, so each achievement slice has
exactly one accountable persona. The planner contract and epic workflow guide
document the requirement and defer numeric achievement thresholds to a
Playtester/Game Designer HUMAN_GATE.

## Evidence

- `tests/unit/agent/floor-epic-lint.test.ts`
- Focused regression suite: 38 tests, including duplicate achievement Owner rejection
- `npm run test:unit -- tests/unit/agent/floor-epic-lint.test.ts`
- `npm run typecheck`
- `npm run lint -- --quiet`
- `bash scripts/agent/verify-fast.sh`
