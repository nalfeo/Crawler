# Handoff: CI recovery quarantines undeclared-scope review findings

## Date

2026-08-28

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 estimated / 2🍎 actual — exact. Tooling-only: one CI-recovery classifier
predicate, one quarantine-explanation string, and regression tests. No review
ledger is required at this tier (`docs/agent-os/policies/review-harness-policy.md`).

## Incident

Loop incident #3807 for PR #3735: the recovery pipeline made no progress after
2 attempts against a single unresolved review thread
(`PRRT_kwDOSvo2Ms6c75Kd`, `#discussion_r3874752710`).

## Root cause

The blocking finding from the trusted reviewer was an **undeclared-scope**
complaint: the branch added release-capture/gallery/art-direction tooling that
the "ten-slot equipment UX" title and description never covered, and the
reviewer asked to either split the branch into dedicated PRs or expand the PR
description.

Everything the incident template suspected was in fact healthy:

- **Marker parser** — no `✅ Addressed` / `✅ Not applicable` marker was ever
  posted, so `shouldResolveThread()` correctly refused to resolve.
- **Prior-recovery hint** — both re-dispatches (`04:30:50Z`, `05:10:46Z`)
  carried the `[Prior recovery reply (no marker posted…)]` prefix, so
  `priorUnresolvedReplyByThread` worked as designed.
- **Permission grant / mutation sequence** — no `resolveReviewThread` mutation
  was attempted, because no trusted marker authorized one.

The actual defect was a **missing terminal classification**. Both remediations
the reviewer asked for are maintainer product decisions that no inline repair
can perform. `reconcile.mjs` already routes that decision class to quarantine +
`ABANDON`/`KEEP` maintainer disposition via `isScopeMismatchReviewBlocker()`,
but the predicate only matched **one direction** — the PR _promising work the
diff does not contain_ (`does not implement`, `not supported`, `scope
mismatch`). The inverse direction — the diff carrying substantial work the PR
never declared — matched nothing, so the finding fell through to ordinary
inline-repair dispatch. The recovery agent correctly declined twice ("leave it
unresolved for human escalation"), and the reconciler re-dispatched an identical
task each time until the retry budget burned out.

## Fix

`isScopeMismatchReviewBlocker()` in `.github/scripts/ci-recovery/state.mjs` now
also matches the undeclared-scope direction. The new branch is a conjunction of
three conservative signals, on top of the existing trusted-author requirement:

1. an undeclared-scope phrase (`not described/mentioned/covered`, `undeclared`,
   `beyond/outside the stated scope`, `conflicts with the stated … scope`,
   `broader than the title`);
2. an explicitly maintainer-only remedy (`split … into dedicated/separate PRs`,
   `expand/amend/update the PR title/body/description`);
3. a scope-promise reference (`PR title`/`PR body`/`PR description`/
   `declared scope`/`stated scope`).

An undeclared-scope observation whose remedy is an ordinary inline repair, or a
bare "expand the PR description" request with no scope finding, still dispatches
normal repair. The quarantine explanation in `reconcile.mjs` was generalized to
name both directions and to tell the maintainer to amend the PR metadata before
posting `KEEP`.

No gate is weakened: the thread stays unresolved, the PR is quarantined pending
an explicit maintainer `ABANDON`/`KEEP`, and the conversation-resolution merge
gate still blocks.

## Files touched

- `.github/scripts/ci-recovery/state.mjs`
- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/state.test.mjs`

## Verification

Observed before/after against the **verbatim** PR #3735 finding, truncated
exactly the way `reconcile.mjs` slices a root review comment into a blocker
summary (450 chars), and again with the `[Prior recovery reply …]` hint prefix
that the last two dispatches actually carried:

- before: `isScopeMismatchReviewBlocker(...) === false` → inline-repair dispatch
  (the observed loop)
- after: `isScopeMismatchReviewBlocker(...) === true` → quarantine + maintainer
  disposition (both with and without the hint prefix)

Test runs:

- `node --test .github/scripts/ci-recovery/state.test.mjs` — 74/74 pass
  (includes the two new regression tests)
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` — 181/181 pass
- `npx prettier --check` and `npx eslint` clean on all three changed files

## Unresolved issues

PR #3735 itself is still open with the same unresolved thread. Once this change
is on `main`, the next reconcile of that PR will quarantine it and ask the
maintainer for `ABANDON` or `KEEP` instead of re-dispatching; the maintainer
still has to make that call (and amend the PR description if keeping it).

## Recommended next steps

- If a future incident shows a _different_ class of blocker the automation
  cannot act on, prefer extending an existing terminal classification over
  adding a new escalation state — the quarantine/`ABANDON`/`KEEP` path already
  carries the maintainer-decision semantics.
