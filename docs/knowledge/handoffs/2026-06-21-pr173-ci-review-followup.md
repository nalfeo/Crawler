# Handoff — PR 173 CI + review follow-up

## Apples

- Estimated: 🍎🍎🍎 (Medium)
- Actual: 🍎🍎🍎 (Medium)
- Delta: 0
- Verdict: 🎯 Exact
- Notes: Merge conflict resolution plus targeted test/CI follow-up stayed within the expected cross-cutting scope.

## Persona routing

- **Producer** — coordinated merge/conflict resolution, CI triage, and final validation.
- **QA Engineer** — fixed strict-type and integration-test drift in the test suites.
- **DevOps Engineer** — investigated GitHub Actions failures and verified the full repo gate.

## What changed

- Merged `origin/main` into `copilot/improve-code-coverage` and resolved the lone conflict in `docs/knowledge/metrics/apple-log.json`.
- Fixed strict TypeScript issues in the new coverage tests after rebasing onto `main`.
- Addressed the actionable review feedback in `tests/ecs/drop-system-knockback.test.ts` by asserting the skipped `DeathTimer` branch emits no new `death` event.
- Updated sprite integration test fixtures/harnesses to match the current content-aware slicer and sensor/postprocess defaults:
  - `generate-one.test.ts`
  - `judge-budget-cache.test.ts`
  - `judge-pipeline.test.ts`
  - `batch-cli.test.ts`

## Validation

- `bash scripts/agent/preflight.sh`
- `npm run typecheck`
- `npx vitest run tests/ecs/aoe-on-impact-system.test.ts tests/ecs/drop-system-knockback.test.ts tests/ecs/door-lock-validation.test.ts tests/ecs/door-navigation.test.ts tests/ecs/knockback-system.test.ts tests/game/behavior-tree-framework.test.ts tests/unit/floor-registry.test.ts tests/unit/level-up-allocation-branches.test.ts --project unit`
- `bash scripts/agent/verify-fast.sh`
- `npx vitest run tests/integration/generate-one.test.ts tests/integration/judge-budget-cache.test.ts tests/integration/judge-pipeline.test.ts tests/integration/batch-cli.test.ts --project integration`
- `bash scripts/agent/verify.sh`

## Result

- Merge conflict resolved.
- Actionable review comment addressed.
- Full local verify is green, so the branch is ready for CI re-run.
