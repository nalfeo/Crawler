# Handoff — Shepherd PR #452 (coverage fix)

**Persona:** Producer · **Apples:** 🍎🍎 (shepherd)

## Systems touched

ci-policy

## What

Shepherded PR #452 `fix: disperse de-aggro mobs from closed safe-room doors` to
squash-merge. The PR was BLOCKED — but not merely on fresh CI: the **Unit Tests**
job failed on the per-file coverage gate for `src/game/enemyAISystem.ts`
(lines 91.61% / stmts 91.36% vs 92% threshold). The new `fleeFromDoorDirection`
helper added branches the single happy-path test didn't exercise.

## Fix

Added two `enemyAISystem` unit cases (no gameplay/seed changes):

- blocked-outward fall-through (door closed, wall outside → yields to wander)
- no-door-in-range wander (mob far from the only door → zero flee → wander)

Whole-suite coverage now: `enemyAISystem.ts` 93.7% lines / 93.68% stmts /
79.49% branches. 2531 unit tests pass. `verify:fast` + `lab-gate-check` green.

## Merge

Floor 1 gate, E2E, Integration all pass; no seeds bent. No human review / no
unresolved review threads. Armed `gh pr merge 452 --auto --squash`.
