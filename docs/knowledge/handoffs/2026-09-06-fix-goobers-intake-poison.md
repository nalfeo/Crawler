# Fix Goobers intake poison

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended**
- Apple estimate: **3**

## Production evidence

Goobers runs `34021610765` and `34021847619` planned the same four assignments:
#4294 as a resume, followed by #4248, #4304, and #4345 as legacy-parity work.
Reservation labeled #4294, then rejected #4248 and aborted before either worker
lane launched.

The two GitHub CLI queries represented #4248's author differently:

- `gh search issues` returned `github-actions[bot]`.
- `gh issue view` returned `app/github-actions` with `is_bot: true`.

The Goobers adapter normalized the search representation but not the
app-qualified issue-view representation. Planning therefore accepted #4248
through the canonical policy while reservation rejected the same actor as
untrusted.

## What changed

- The shared GitHub CLI adapter now canonicalizes the exact
  `app/github-actions` bot alias to `github-actions[bot]`, so planning and
  reservation pass equivalent payloads to the same intake policy without
  widening the trusted-opener set.
- Reservation validates the complete planned set before mutating any issue.
  Candidates that close, gain an assignee, leave the intake cohort, or become
  blocked after planning are skipped while unrelated valid assignments continue.
  GitHub API and malformed-assignment failures remain fail-closed.
- Reservation publishes only the assignments whose label mutation is about to
  be attempted. If a later mutation or start-comment operation fails, the
  always-gated release job receives the exact conservative cleanup set rather
  than every planned candidate.
- Executable regressions cover the production author-alias mismatch, an
  untrusted bot ahead of valid candidates, continued valid reservation, numeric
  lane/slot values, empty resume fields, and cleanup after a later mutation
  failure.

## Operational state

No production label mutation was performed. #4294 still has an open Goobers PR
(#4351), so its `goobers/status:in-review` label remains correct. #4248, #4304,
and #4345 have no Goobers reservation label. No operational label remediation is
required.

## Validation

- `node --test .github/scripts/goobers/intake-selection.test.mjs` — 20 passed.
- `node .github/scripts/validate-goobers-contracts.mjs` — 9 workflows and 19
  fixtures passed.
- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts
tests/unit/goobers-run-slot-cleanup.test.ts tests/unit/goobers-contracts.test.ts
tests/unit/goobers-lifecycle-ownership.test.ts
tests/unit/goobers-workflow-checkout-contract.test.ts --reporter=dot` — 195
  passed, 2 platform-gated skips.
- `npm run test:guards` — passed.
- Prettier check on all changed source, workflow, and test files — passed.

## Apples

Estimated **3**, actual **3** — exact: the repair spans the canonical adapter,
reservation transaction, and executable workflow regressions while remaining
inside CI tooling.
