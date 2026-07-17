# Accept Markdown addressed markers in CI Recovery

## Date

2026-07-17

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples. Exact: the fix remained a narrow parser
normalization plus focused state and mocked reconcile regressions.

## What changed

- Normalized balanced outer Markdown inline-code delimiters around addressed-marker
  SHA or commit-URL tokens after removing trailing prose punctuation.
- Kept malformed or unbalanced wrappers fail-closed, including embedded backticks,
  while preserving raw SHA, raw commit URL, trust identity, last-comment-only, and
  current-head/ancestor lineage behavior.
- Added state coverage for raw, punctuated, inline-code, malformed, and non-commit
  URL forms.
- Added a live mocked reconcile regression proving one trusted backtick-wrapped
  marker emits exactly one `resolveReviewThread` mutation while untrusted and
  malformed markers emit none.

## Observe before done

- Before: `extractAddressedMarkerSha('✅ Addressed in \`a9c5fdb\`: ...')`returned`null`, so CI Recovery left an otherwise resolvable review thread open.
- After: balanced inline-code SHA and commit-URL forms resolve to their normalized
  SHA, while unbalanced or embedded delimiters remain invalid.
- Real artifact: `.github/scripts/ci-recovery/reconcile.mjs` executed through the
  subprocess mock GitHub API harness and selected only the trusted wrapped marker
  for the PAT-backed GraphQL resolution path.

## Verification

- `node --test .github/scripts/ci-recovery/state.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
  (91 tests, 47 passed, 44 documented Windows subprocess teardown skips, 0 failed)
- `node --test --test-name-pattern "live reconcile resolves only a trusted backtick-wrapped current-head marker" .github/scripts/ci-recovery/reconcile.test.mjs`
  (1 passed, 0 skipped)
- `npx prettier --check .github/scripts/ci-recovery/state.mjs .github/scripts/ci-recovery/state.test.mjs .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`

## Risks

- Inline-code normalization accepts only balanced outer backtick runs with no
  embedded backticks. This intentionally excludes more permissive Markdown parsing
  so malformed marker text cannot broaden auto-resolution.
