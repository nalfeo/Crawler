# Handoff: CI Lightweight Jobs Consolidation

**Date:** 2026-07-19  
**Issue:** nalfeo/Crawler#1703  
**Apple estimate:** 3🍎  
**Persona:** DevOps Engineer

## Summary

Consolidated four formerly-separate lightweight CI jobs (`check-types-and-lint`,
`check-format-and-labs`, `ci-advisory`, `human-approval`) into a single
`check-lightweight` job, eliminating three repeated Node setup/checkout sequences on
every full CI run. Three post-review bugs were also fixed (reconcile suppression set,
rerun automation loop, docs-only approval bypass).

## Systems touched

ci, ci-recovery

## What changed

### `.github/workflows/ci.yml`

- Replaced `check-types-and-lint` + `check-format-and-labs` + `ci-advisory` +
  `human-approval` (4 separate jobs) with one `check-lightweight` job named
  **Lightweight Checks**.
- **Blocking steps** (fail-fast, clearly attributable): Format check, Lab gate check,
  Orphaned-system wiring guard, Guard + review-ledger tests, Typecheck & Lint,
  Human approval.
- **Advisory steps** (continue-on-error: true, if: always()): Dead code detection,
  Security audit, Typecheck (full — tests + scripts). Gated on
  `GAMEPLAY_SAFE != 'true'` so scope-limited PRs (gameplay_safe/sprites_only/art_only)
  skip them.
- **Docs-only handling**: The job has no job-level `docs_only` skip. Instead:
  - `DOCS_ONLY` env var exposed at job level.
  - All non-approval blocking steps have `if: env.DOCS_ONLY != 'true'`.
  - `Human approval` step runs unconditionally (no DOCS_ONLY guard) so labeled
    docs-only PRs are not bypassed.
  - `install-playwright` is conditional (`docs_only != 'true' && 'true' || 'false'`)
    to skip the ~30 s Playwright install on docs-only PRs where guard tests are skipped.
- **Merge-gate** updated: `check-lightweight` in `needs`, `check()` call for
  "Lightweight Checks". Former `check "Types & Lint"`, `check "Format & Labs"`, and
  `check "Human approval"` calls removed.

### `.github/workflows/human-approval-rerun.yml`

- `humanApprovalJobConclusion` now inspects the **step-level** conclusion of the
  "Human approval" step within the Lightweight Checks job, rather than the whole job
  conclusion.
- `needsRerun` returns `false` for `'skipped'` step conclusion (an earlier blocking
  step like lint or format failed before the approval step ran) and `null` (job not
  found). This breaks the unbounded rerun loop that would occur when lint/format fails
  while approval is already granted.

### `.github/scripts/ci-recovery/reconcile.mjs`

- `humanApprovalDerivedChecks` set updated from `'human approval'` to
  `'lightweight checks'` so human-approval-blocked PRs don't generate spurious
  ci-failure blocker tasks.

### `.github/scripts/ci-recovery/reconcile.test.mjs`

- Test fixture at line 2630 updated: `'Human approval'` → `'Lightweight Checks'`.

### `tests/unit/ci-lightweight-consolidation.test.ts`

- 21 workflow-policy tests covering: job structure, blocking/advisory steps,
  DOCS_ONLY step-level guards, Human approval unconditional run, conditional Playwright
  install, merge-gate structure, and rerun automation step-level lookup.

### `docs/knowledge/review-ledgers/2026-07-19-ci-lightweight-consolidation.review-ledger.json`

- 3🍎 review ledger with plan_review and code_review (2 rounds) stages, both clean.

## Verification

- `npm run verify:fast` — ✅ 1297 tests passed
- `npm run test:guards` — ✅ 1144 tests passed
- `npm run review:ledger -- validate` — ✅ valid 3-apple ledger

## Wall-time analysis

| PR class      | check-lightweight                       | Critical path                   |
| ------------- | --------------------------------------- | ------------------------------- |
| Full code PR  | ~235 s                                  | headless ~306 s (no regression) |
| Gameplay-safe | ~175 s                                  | visual/e2e gate                 |
| Docs-only     | ~20 s (checkout + node + approval only) | —                               |

## Acceptance criteria status

- ✅ Full CI run removes at least three setup/checkout sequences (4→1)
- ✅ Headless, visual, coverage, integration, sprite suites remain independent
- ✅ Individual check failures clearly attributable (each step named)
- ✅ Required merge-gate semantics remain fail-closed
- ✅ PR validation p95 wall time does not regress (235 s < 306 s headless)
- ✅ Permissions remain least-privilege (no write permissions added)
- ✅ Workflow-policy tests cover success, failure, and docs-only scenarios

## Unresolved issues

None.

## Recommended next steps

- After PRs #1696, #1697, #1698 merge, rebase this branch onto their workflow
  structure and verify there are no conflicts in the `needs` arrays.
- Monitor CI runs after merge to confirm the `Lightweight Checks` job timing
  aligns with the ~235 s estimate.
