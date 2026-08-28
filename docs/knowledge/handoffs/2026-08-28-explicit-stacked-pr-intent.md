# Explicit stacked-PR intent gate (2026-08-28)

## Summary

Adds a deterministic `stacked-pr` label policy so Crawler's stale-base
scanner can distinguish intentionally-stacked PRs from accidental
non-main targets without any LLM judgement.

## Problem

Before this change, `classifyStaleBase` returned `base-pr-open` (skip) for
**every** PR whose base branch had an open parent PR. This meant:

- A PR accidentally pushed against a feature branch would never be
  auto-retargeted to `main` as long as that branch had any open PR.
- There was no canonical way to record intent, so humans had to remember
  to retarget manually after the parent merged.
- After the parent landed, existing stale-base logic already retargeted
  correctly, but only if the child didn't also race through before the
  next scanner sweep.

## Solution

Four interlocking changes:

1. **`stacked-pr` label** — explicit opt-in that tells the scanner "this
   child is intentionally stacked; leave it alone while the parent is open".
   Label may only be added by Copilot when a human explicitly requests it.

2. **5-minute grace window** — unlabeled PRs targeting a non-main branch
   get a 5-minute grace period from `created_at`
   before the scanner retargets them. Prevents automation from immediately
   retargeting a PR the moment it is opened.

3. **Normalization after parent lands** — once the parent PR merges or its
   branch disappears, the `stacked-pr` label is ignored and the child is
   retargeted to `main` by the existing stale-base classification paths. A
   closed, unmerged parent branch remains because its commits may still be a
   real dependency.

4. **Native-stack normalization** — when GitHub rejects the base PATCH because
   the PR belongs to a native stack, CI Recovery calls the 2026-03-10 stacks API
   to unstack it, verifies the target PR was removed even on a partial `200`
   response, and retries the PATCH. The old merge-forward fallback left the
   non-main base intact and therefore could not satisfy normalization.

## Systems touched

ci-recovery, docs/policies

## Apples

Estimated 3🍎, actual 3🍎 — tooling-only, well-bounded.

## Changes

- `.github/scripts/ci-recovery/router.mjs`:
  - Added the exported `STACKED_PR_LABEL = 'stacked-pr'` and a structural five-minute grace constant.
  - Modified `classifyStaleBase` signature to accept `nowMs` (injectable clock for tests).
  - Replaced single `base-pr-open` skip with label-aware / grace-period logic (3 new outcomes:
    `labeled-stacked-pr-open`, `unlabeled-grace-period`, `unlabeled-stacked-pr-expired`).
  - Replaced the merge-forward fallback with verified native unstack + retarget.

- `.github/scripts/ci-recovery/router.test.mjs`:
  - Updated existing `base-pr-open` test to use the new reason code and label.
  - Added deterministic regression tests covering intent, grace, parent landing,
    native unstack, partial unstack, and retarget retry paths.

- `docs/agent-os/policies/ci-policy.md`:
  - Added "Stacked-PR Label Policy" section documenting label semantics, who
    may apply the label, behavior table, and implementation pointer.

## Verification

- `node --test .github/scripts/ci-recovery/router.test.mjs` — all stale-base tests pass.
- No merge-train code was modified.
- Grace window and label logic are pure functions with injected clock — fully deterministic.
