# Goobers model unpin and PR resync

## Systems touched

agent-tooling, ci

## Summary

The Goobers Producer, Coder, and Reviewer configurations were restored to
`model: auto` after the maintainer objected to hard-pinning the agents to a
specific model. The follow-up branch was also synchronized with `origin/main`
after PR #3643 had already merged, preserving the newer Goobers auto-trigger
recovery work from main while keeping the E2E diagnostics and review-loop
hardening changes.

## Files touched

- `.goobers/gaggles/crawler/goobers/producer/goober.yaml` — restored automatic
  model selection.
- `.goobers/gaggles/crawler/goobers/coder/goober.yaml` — restored automatic
  model selection.
- `.goobers/gaggles/crawler/goobers/reviewer/goober.yaml` — restored automatic
  model selection.
- `.goobers/gaggles/crawler/workflows/crawler-feature-pr.yaml` — kept the
  review gate's six-repass budget while preserving main's reviewer retry block.
- `docs/knowledge/handoffs/2026-08-26-goobers-ci-first-dispatch.md` — recorded
  the follow-up validation run in the prior Goobers setup history.
- `docs/knowledge/metrics/guard-telemetry/2026-08-27-goobers-ci-first-dispatch.json`
  — captured guard telemetry produced during PR prereq validation.

## Verification

- `Goobers Validate` passed on commit `f719a2567`, run `33044287447`.
- `npm run verify:pr-prereqs` initially passed before the main sync; after the
  merge from `origin/main`, it correctly required this new handoff file.
- Pre-push Prettier checks passed on the model-unpin and merge commits.

## Unresolved issues

- The full `goobers-run.yml` E2E flow still needs another live dispatch against
  issue #3639 to prove the diagnostics comments, context fallbacks, and expanded
  review repass budget together produce the feature PR.
- The branch has a merge commit from `origin/main` because a plain rebase tried
  to replay already-squashed PR #3643 commits and conflicted.

## Recommended next steps

1. Rerun `npm run verify:pr-prereqs` after this handoff is committed.
2. Let CI validate the synchronized PR branch.
3. Dispatch `goobers-run.yml` again for the bounded E2E retry loop once the
   workflow changes are in place.
