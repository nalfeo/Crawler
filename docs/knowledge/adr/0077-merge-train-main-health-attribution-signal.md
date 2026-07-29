# ADR 0077: Merge-Train Main-Health Is an Attribution Signal, Not a Promotion Gate

## Status

Accepted

## Date

2026-07-28

## Estimated Complexity

🍎 x 3 — tooling-only (per the complexity policy's tooling cap), but the diff
changes merge-gating semantics across both the merge train and CI, and the
merge-train test surface is dense and characterization-based.

## Context

The merge train validates a **composite** candidate — `main+PR1`,
`main+PR1+PR2`, … — through the full merge gate. `planPrefixPromotion`
(`.github/scripts/merge-train/state.mjs`) validates the maximal prefix first and
bisects only on a genuine terminal failure. That composite result is a complete
promotion gate on its own: it proves the exact tree that will land is green.

Promotion was nevertheless gated a **second** time on `main`-alone being green,
via `mainHealthAllowsPromotion()` in `promotePrefix`, and again as
`reattestHealth` immediately before the merge API call. `mainHealthReason()`
failed closed — missing, pending, or red evidence all blocked promotion.

Three consequences:

1. **Deadlock.** A PR that _fixes_ a red `main` could never land: its composite
   was green, but `main` alone was red and there was no exemption. Recovery
   required disabling the train and merging through the legacy path — a
   documented manual lane (ADR 0060 era, `docs/guides/merge-train.md`).
2. **Latency.** `main`'s own CI sat on the critical path of every promotion,
   re-proving what the composite validation had already proven.
3. **Evidence starvation.** `mainHealthReason()` excludes train fast-path push
   runs, so after every promotion the new `main` had _no_ authoritative evidence
   until the next scheduled full-CI run — making the hourly `ci.yml` cron a
   load-bearing part of train throughput.

The gate did carry one property worth keeping. It is an **attribution circuit
breaker**, not a correctness gate. A red composite has two possible causes — the
PR broke it, or `main` was already broken — and the composite result alone cannot
distinguish them. Because a validation failure _ejects_ the first failing
addition (`merge-train-blocked` + `merge-train-validation-failed` + recovery
dispatch), a `main` that is red for an unrelated reason makes every prefix
including prefix 1 fail, bisection converges on green=0/red=1, and the train
ejects innocent PRs one per round down the whole queue.

## Decision

**Main-health is demoted from a promotion gate to a failure-attribution
signal.** The validated composite prefix becomes the sole promotion gate.

| maximal composite | main verdict        | behaviour                                                                                            |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| success           | _not consulted_     | promote                                                                                              |
| failure           | `green` / `unknown` | bisect, isolate, eject (unchanged)                                                                   |
| failure           | `red`               | eject nothing. An already-proven green prefix still promotes; any further bisection round is skipped |

- `mainHealthReason()` is replaced by `mainAttributionVerdict()`, returning
  `green` / `red` / `unknown`.
- `planAttributedPrefixPromotion()` wraps `planPrefixPromotion()` and consults
  the verdict **only** when the maximal composite failed. On `red` it suppresses
  `firstFailure` (the ejection index) while preserving any proven-green prefix
  promotion, and collapses a would-be bisection round to `action: 'pause'`.
  Ejection and bisection dispatch are both driven off that single return value.
- `reattestHealth` is removed from `promoteExactBatch` / `promoteExactCandidate`
  entirely.
- `ci.yml`'s scheduled run stretches from hourly to daily and is decoupled from
  `MERGE_TRAIN_ENABLED`.

`planPrefixPromotion` / `nextBisectStep` maximal-first + binary-search behaviour
is unchanged.

### The verdict fails OPEN on `unknown`

Only a **positive** `red` pauses. This is the opposite of the gate it replaces,
and deliberately so. Absence of evidence attributes nothing, and after every
train promotion the only run on the new `main` is the excluded fast-path
attestation — so `unknown` is the steady state. A fail-closed attribution
breaker at daily backstop cadence would suspend ejection of genuinely broken PRs
for up to a day, which is a far worse failure mode than a rare unattributed
ejection: an ejected PR returns to ci-recovery and re-queues, while a train that
cannot eject anything is not self-healing.

### `reattestHealth` is dropped, not relocated

Everything it uniquely added is already covered:

- `main` moving → `promotionStaleReason`, the whole-batch `finalMain` guard, and
  the per-merge base-CAS.
- A divergent landing → the fail-closed post-merge parent/tree proof
  (`landedCommitProofError`), which asserts the landed tree is byte-identical to
  the validated candidate prefix tree.

The only case left is `main` going red **without moving** (a CI re-run on the
same SHA concluding differently), which is not a promotion concern under the new
semantics: the candidate was validated against that exact SHA. Keeping it would
simply reinstall the deadlock at the final reattestation.

### CI cadence and the scheduled backstop

The scheduled `ci.yml` run does a second job unrelated to main-health: it forces
every scope flag off, making it the only unconditionally-full CI run in the
system and the backstop against `detect-art-only.sh` misclassification. That
value survives; hourly cadence does not. The cron becomes `0 6 * * *`.

Because the backstop role is now independent of the train, the `changes` job no
longer gates on `MERGE_TRAIN_ENABLED`, and the matching merge-gate bypass is
removed. `ci-recovery-incidents.yml` is updated in lockstep: it previously
discarded scheduled CI while the train was disabled on the assumption that such
runs were no-ops. That assumption is now false, and leaving it would mean a
failed daily backstop raised no incident during a rollback — the exact window
where it is the only full run left.

The main-push heavy-CI skip for train-promoted pushes is retained but
re-grounded: it rests on the landed-tree-equality proof (the full gate already
ran on exactly this tree), not on a deferral to a scheduled run that no longer
arrives hourly.

## Consequences

### Positive

- A PR that fixes a red `main` lands through the train. The deadlock is gone.
- `main`'s own CI leaves the promotion critical path.
- A composite failure on a red `main` costs zero bisection rounds instead of
  `O(log n)` unattributable ones.
- CI spend drops by ~23 scheduled full runs per day.
- Train throughput no longer depends on scheduled-CI cadence.

### Negative / accepted

- If `main` is positively red **and** the maximal composite genuinely fails, the
  train stops isolating and ejects nothing until `main` is green, so a
  genuinely-broken queued PR sits in the queue instead of being ejected. Any
  prefix already proven green still promotes, so a queued repair PR is not
  blocked. Escapable by dropping the broken PR's queue label.
- A `main` that is broken _without_ any completed failing CI run for its SHA can
  now drive one unattributed ejection per round. Bounded and recoverable.
- Misclassification by `detect-art-only.sh` is now caught within 24h rather than
  1h. Push-CI on `main` already runs `test-headless` and `ci-coverage`
  unconditionally, so the backstop delta is limited to
  art-only/docs-only/sprites-only/narrow-visual commits.

### Neutral

- `deploy.yml` rejects non-push `workflow_run`, so scheduled CI never released;
  the cron change has no release-cadence effect.
- The `merge-train.yml` scheduled-CI workflow_run carve-out is retained: it is
  now the wakeup for the attribution pause rather than for a pending-health
  window.

## Alternatives Considered

1. **Keep the gate, add a "this PR fixes main" exemption.** Requires the train
   to decide autonomously that it is safe to build on known-broken code — the
   exact trust hole the guide's boundary exists to prevent. The composite
   already answers the question without any such judgement.
2. **Keep hourly cron and change nothing else.** Leaves the deadlock, the
   latency, and the cost.
3. **Delete the scheduled run entirely.** Loses the unconditionally-full
   backstop against scope misclassification, which is independent of the train.
4. **Fail closed on `unknown`.** Analysed and rejected: it would convert the
   demotion into a 24-hour ejection stall, because `unknown` is the post-promotion
   steady state.

## Related

- ADR 0060 — repository-managed speculative merge train
- ADR 0063 — real GitHub squash-merge promotion (`landedCommitProofError`)
- `docs/guides/merge-train.md` — operator procedures
