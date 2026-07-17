# Handoff: CI Recovery Router trigger hygiene

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated and actual — workflow event classification, concurrency routing,
and deterministic regression coverage fit the planned medium tooling slice.

## What changed

- Managed CI recovery state, task, and merge-train comments now fail the router
  job guard before runner allocation. The script-level marker check remains as
  defense-in-depth.
- Train-mode PR-scoped events now reconcile only the PRs represented by the
  event. They still hydrate the open-PR list and apply the existing same-repo,
  draft, base, queue, opt-out, and owner eligibility rules.
- Full six-slot repair-window scans are limited to schedule/manual events, the
  trusted post-queue fill dispatch, closed-PR fill events, and default-branch CI
  workflow events without an associated PR.
- Global repair sweeps retain GitHub's default one-active/one-latest-pending
  concurrency. Targeted events use PR-scoped groups, including single-PR
  workflow runs, so unrelated global sweeps cannot coalesce them away.
- The router still has no `queue: max`; recovery ownership and lease state were
  not changed.

## Deterministic observation

- Before this change, the train-mode direct-event fixture for PR #3 returned
  the unrelated oldest repair window `[2, 3, 4, 5, 6, 7]`. It now returns only
  `[3]`.
- Before this change, managed automation comments allocated a runner and were
  ignored by the script. The parsed production workflow now proves all three
  markers are rejected by the job-level guard, while the script test retains
  the fallback defense.
- Schedule/manual and default-branch CI fixtures prove oldest-first selection,
  the six-slot cap, owner-slot behavior, opt-out cleanup, same-repository trust,
  flag-off label priority, and the no-eligible result.
- Production run-count impact can only be observed after the workflow reaches
  the default branch.

## Expected production impact

The measured 20.4-hour baseline contained 873 managed-comment runs that only
reached the script-level ignore path. The job guard should remove all runner
work for those records, reducing router job starts by about 27.6% and saving
about 211 runner-minutes per comparable window. Exact routing also removes the
opportunistic subset of the baseline's 1,526 sweep dispatches that came from
PR-scoped events; retained schedule/manual/fill/default-branch-CI sweeps remain
bounded to six, so the aggregate dispatch reduction depends on the future event
mix.

## Validation

- `node --test .github/scripts/ci-recovery/router.test.mjs` — 22 passed.
- `npm run verify:fast` — passed.
- `npx prettier --check .github/scripts/ci-recovery/router.mjs .github/scripts/ci-recovery/router.test.mjs .github/workflows/ci-recovery-router.yml docs/guides/ci-recovery.md`
  — passed.

## Review harness

- Separate-model plan review (`gpt-5.4`) approved with four refinements, all
  adopted; `plan_divergence=minor`.
- Two final-diff code-review passes (`claude-sonnet-4.6`) found no concerns.
