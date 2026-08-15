# 2026-08-14 — Duplicate PR closer: empty-diff grace window

## Systems touched

ci-recovery

## Apple estimate

2🍎 (tooling-only, CI harness; no runtime gameplay or shipped game data changed)

## Summary

PR #2948 was a brand-new PR with an active Copilot session on it. It was auto-closed as
a "provable duplicate" before the agent had pushed its first commit, and had to be
manually reopened.

Root cause: `.github/workflows/ci-pr-disposition.yml` auto-closes any open PR for which
`detectDuplicateProof` returns a proof, and the only auto-close proof is `EMPTY_DIFF`
(`additions === 0 && deletions === 0`). A freshly opened PR whose agent has not pushed
yet has exactly that shape, so it was read as "all changes already on main". The existing
live re-validation step did not catch it: it re-fetched the PR and re-ran the same rule
against the same still-empty diff, re-confirming the bad proof.

Fix: an empty diff is only evidence of redundancy once the PR has been empty long enough
that nobody is still filling it. `EMPTY_DIFF` now additionally requires PR age >= 6h since
`created_at` and quiescence >= 1h since `updated_at`. Unknown or unparseable timestamps
(including a missing `nowMs`) are treated as "too young", preserving the module's
conservatism invariant.

The legacy coordinator-superseded close path in the same per-PR loop had no diff or age
check at all, so fixing only the proof rule would have left a second way to close a fresh
PR. The workflow now applies the freshness guard once at the top of the per-PR loop and
`continue`s, so every close path in that job inherits it and logs a `skip-close-grace`
notice.

Review round 1 hardened this further: the grace rule now lives in one exported helper,
`evaluateCloseGrace()`, which fails closed when **any** of `nowMs` / `createdAt` /
`updatedAt` is absent or unparseable (previously a missing `updatedAt` silently fell back
to `createdAt`, so an aged PR with unknown update time could still prove). The
coordinator-superseded path also re-fetches the PR and re-evaluates the grace window on
**live** timestamps immediately before closing, because the loop-level guard reads the
repository-wide `pulls.list` snapshot, which can be stale by the time the close executes.

## Files touched

- `.github/scripts/ci-recovery/duplicate-detect.mjs` — `proveEmptyDiff` takes
  `{ nowMs, minAgeMs, minQuietMs }`; new exported `EMPTY_DIFF_MIN_AGE_MS` (6h),
  `EMPTY_DIFF_MIN_QUIET_MS` (1h) and `evaluateCloseGrace()`; `detectDuplicateProof`
  threads the options through.
- `.github/scripts/ci-recovery/duplicate-detect.test.mjs` — grace-window coverage plus a
  regression test named for the #2948 shape, and fail-closed cases for every unknown
  timestamp combination.
- `.github/workflows/ci-pr-disposition.yml` — passes `created_at`/`updated_at`/`nowMs` on
  both the initial and live-revalidation proof calls; shared per-PR freshness guard via
  `evaluateCloseGrace`; live re-fetch + re-check (and live `headSha`) on the
  coordinator-superseded close.
- `tests/unit/ci-pr-disposition-workflow.test.ts` — regression test that both close paths
  use the shared helper and that the coordinator path re-checks live timestamps first.
- `tests/unit/ci-knobs-guard.test.ts`, `docs/agent-os/policies/ci-config-knobs.md` —
  register the two new structural constants (required by the CI knobs guard).

## Verification run

- `node --test .github/scripts/ci-recovery/duplicate-detect.test.mjs` → 27/27 pass
- `node --test .github/scripts/ci-recovery/pr-lifecycle.test.mjs` → 30/30 pass (unchanged)
- `npx vitest run tests/unit/ci-knobs-guard.test.ts tests/unit/ci-pr-disposition-workflow.test.ts`
  → 176/176 pass
- `npx prettier --check` on all changed files → clean

New deterministic coverage: aged+quiet empty PR still proves; brand-new empty PR does not;
old-but-recently-active empty PR does not; missing/invalid timestamps do not.

## Unresolved issues

- The 6h / 1h thresholds are a judgement call, not derived from measured session data. If
  agent sessions routinely take longer than 6h to first push, raise `EMPTY_DIFF_MIN_AGE_MS`.
- A more precise signal would be "is there an active Copilot session on this PR", but that
  is not deterministically readable from the GitHub API surface the workflow already uses,
  so age+quiescence is the deterministic proxy.
- Quarantine labelling is intentionally unchanged: a too-fresh PR is skipped entirely for
  the cycle rather than tagged, so a later run evaluates it normally.

## Recommended next steps

- Watch `skip-close-grace` notices in the CI PR Disposition run log to confirm the guard
  fires on real fresh PRs and does not suppress legitimate stale-empty closes.
- Consider emitting a counter for grace-skipped PRs if the disposition job ever needs
  tuning evidence for the thresholds.
