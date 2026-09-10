# CI Recovery closing-issue acceptance scope

## Date

2026-09-03

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact). This is CI lifecycle tooling with new
deterministic admission/quarantine coverage.

## Summary

- CI Recovery now hydrates closing issue bodies from
  `closingIssuesReferences`.
- Added a deterministic acceptance-scope evaluator for closing issues with an
  `Acceptance criteria` section. Evidence is evaluated per closing issue: when
  the criteria name repository paths, the diff must touch that issue's own
  paths (so unrelated source/test churn cannot satisfy it, and a multi-issue PR
  cannot pass every issue by implementing one); when they name none, the
  coarser diff-shape signal (some executable change and some test change) is
  used. Documentation-only issues (by label or `Docs:` title convention only —
  never by body prose) and non-closing references are skipped.
- Wired the evaluator before lifecycle admission so planning-only PRs that use
  `Fixes` / `Closes` / `Resolves` for feature issues enter the existing
  non-blocking quarantine lifecycle with an actionable missing-evidence reason.
- Made lifecycle admission ignore stale lifecycle phases whose stored head SHA
  no longer matches the current PR head, so a new push can re-run the
  head-bound scope check and transition out of quarantine when fixed. A
  metadata-only fix (downgrading `Fixes` to `Refs`, which keeps the same head)
  also clears the quarantine: once the mismatch is gone, the recorded
  closing-issue quarantine is invalidated and the PR returns to `repairing`.
- A failed `pulls/{n}/files` hydration now defers the check instead of reading
  the empty file list as absent evidence, so a transient API failure can never
  quarantine a healthy feature PR.

## Files touched

- `.github/scripts/ci-recovery/github.mjs`
- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/state.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `.github/scripts/ci-recovery/state.test.mjs`

## Verification

- `node --test .github/scripts/ci-recovery/state.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs` initially failed only because this handoff did
  not exist yet; rerun after this file is committed.

## Unresolved issues

- None known.

## Recommended next steps

- Let CI exercise the full workflow set after publication.
