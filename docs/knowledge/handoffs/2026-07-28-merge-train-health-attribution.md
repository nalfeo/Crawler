# Merge train: main-health demoted from promotion gate to attribution signal

**Date:** 2026-07-28
**Apples:** 3🍎 estimated / 3🍎 actual
**Branch:** `nalfeo-merge-train-health-attribution`
**ADR:** [0077](../adr/0077-merge-train-main-health-attribution-signal.md)

## Systems touched

ci-policy

## Problem

The merge train validates a **composite** candidate — `main+PR1`,
`main+PR1+PR2`, … — through the full merge gate. That composite is a complete
promotion gate on its own: it proves the exact tree that will land is green.

Promotion was nevertheless gated a **second** time on `main` alone being green,
via `mainHealthAllowsPromotion()` in `promotePrefix` and again as
`reattestHealth` immediately before the merge API call. `mainHealthReason()`
failed closed — missing, pending, **and** red evidence all blocked promotion.

Three consequences:

1. **Deadlock.** A PR that _fixes_ a red `main` could never land: its composite
   was green, but `main` alone was red and there was no exemption. Escape
   required disabling the train and merging through the legacy path — a
   documented manual lane.
2. **Latency.** `main`'s own CI sat on the critical path of every promotion,
   re-proving what the composite had already proven.
3. **Evidence starvation.** `mainHealthReason()` excludes train fast-path push
   runs, so after every promotion the new `main` had _no_ authoritative evidence
   until the next scheduled full-CI run — making the hourly `ci.yml` cron a
   load-bearing part of train throughput. `merge-train.yml` conceded the `*/5`
   cron "arrives ~hourly in practice".

The gate did carry one property worth keeping: it is an **attribution circuit
breaker**. A red composite has two causes — the PR broke it, or `main` was
already broken — and the composite result alone cannot distinguish them. Because
a validation failure _ejects_ the first failing addition, a `main` that is red
for an unrelated reason makes every prefix including prefix 1 fail, bisection
converges on green=0/red=1, and the train ejects innocent PRs one per round down
the whole queue.

## What changed

**Main-health is no longer on the promotion path at all.** The validated
composite prefix is the sole promotion gate. The verdict is consulted only to
attribute a _failure_.

| maximal composite | main verdict        | behaviour                                                                         |
| ----------------- | ------------------- | --------------------------------------------------------------------------------- |
| success           | _not consulted_     | promote                                                                           |
| failure           | `green` / `unknown` | bisect, isolate, eject (unchanged)                                                |
| failure           | `red`               | eject nothing; still promote a proven-green prefix; skip further bisection rounds |

- `mainHealthReason()` → `mainAttributionVerdict()`, returning
  `{ verdict: 'green' \| 'red' \| 'unknown', reason }` (`reconcile-lib.mjs`).
- New `planAttributedPrefixPromotion({ prefixStates, mainVerdict })`
  (`state.mjs`) wraps `planPrefixPromotion`. On a red `main` it suppresses
  `firstFailure` (the ejection index) while preserving any proven-green prefix
  promotion, and collapses a would-be bisection round to `action: 'pause'`.
  Ejection and dispatch are both driven off that one return value, so the
  breaker cannot be bypassed by one caller forgetting to consult it.
- `planPrefixPromotion` / `nextBisectStep` are **unchanged** (maximal-first +
  binary search preserved).
- `reattestHealth` removed from `promoteExactBatch` / `promoteExactCandidate`.
- `ci.yml`: cron `0 * * * *` → `0 6 * * *`; the `changes` job no longer gates on
  `MERGE_TRAIN_ENABLED`; the train-promoted push skip is regrounded on the
  landed-tree-equality proof; the stale `schedule && train disabled` merge-gate
  bypass is deleted.
- `ci-recovery-incidents.yml`: `route-incident` now routes scheduled CI
  unconditionally.

### Two decisions worth carrying forward

**`mainAttributionVerdict` fails OPEN on `unknown`** — the opposite of the gate
it replaced. Absence of evidence attributes nothing, and after every train
promotion the only run on the new `main` is the excluded fast-path attestation,
so `unknown` is the _steady state_. A fail-closed breaker at daily backstop
cadence would suspend ejection of genuinely broken PRs for up to a day. An
unattributed ejection is recoverable (ci-recovery re-queues); a train that
cannot eject anything is not self-healing.

**`reattestHealth` was dropped, not relocated.** Main _movement_ is covered by
`promotionStaleReason`, the whole-batch `finalMain` guard, and the per-merge
base-CAS; a divergent landing is caught fail-closed by `landedCommitProofError`.
Its only unique coverage was "main went red **without moving**" (a CI re-run on
the same SHA concluding differently), which is not a promotion concern once the
candidate was validated against that exact SHA. Keeping it would have
reinstalled the deadlock at the final reattestation.

### Why the cron survives at all

The scheduled run does a second job unrelated to main-health: it forces every
scope flag off (`art_only=false`, `docs_only=false`, `gameplay_safe=false`,
`sprites_only=false`), making it the **only unconditionally-full CI run in the
system** — the backstop against `detect-art-only.sh` misclassifying a commit and
skipping gates that should have run. That value survives the demotion; hourly
cadence does not. Deleting the cron would have been a real regression.

Because the backstop role is now independent of the train,
`ci-recovery-incidents.yml` had to change in lockstep: it previously discarded
scheduled CI while the train was disabled, assuming those runs were no-ops. Once
`ci.yml`'s schedule gate is gone that assumption is false, and leaving it would
mean a failed daily backstop raised no incident **during a rollback** — exactly
when it is the only full run left. This was caught by the plan review, not by me.

## Observe before done (before/after)

The real artifact here is the reconcile script's behaviour, not a lab.

**Before** (`reconcile-promotion.test.mjs`, old test "promoteExactBatch pauses
when main health regresses at final reattestation"): a fully validated candidate
with `reattestHealth: async () => false` produced `promise === false` and
`records.merges.length === 0` — the merge never issued.

**After** (same input, new test "promoteExactBatch promotes a validated
candidate regardless of main-alone health"): `promise === true` and
`records.merges.length === 2`. A green composite now lands on a red `main`.

The attribution property is proven separately in `reconcile.test.mjs`:
`planPrefixPromotion(['success','failure','failure'])` returns
`firstFailure: 1` (today: eject entry index 1), while
`planAttributedPrefixPromotion` with a `red` verdict on the same input returns
`firstFailure: -1` **and** still promotes `greenPrefixLength: 1`.

## Verification

- `node --test ".github/scripts/merge-train/*.test.mjs"` — 238 pass, 0 fail
- `npm run test:guards` — 1964 pass, 0 fail
- `npm run verify:fast` — green

## Gotchas discovered

- **`node --test <dir>` does not work** on this repo's merge-train scripts —
  Node treats the bare directory as a module path and throws `MODULE_NOT_FOUND`.
  Use the glob: `node --test ".github/scripts/merge-train/*.test.mjs"`.
- **The characterization fixtures did NOT need regeneration**, contrary to the
  brief's expectation. `verdict-fixtures.json` only exercises
  `planPrefixPromotion`, `queueEntries`, `shouldWaitForCiConflictOrder`,
  `admissionFingerprint`, and `unsatisfiedChecks` — none of which changed. The
  new behaviour is a _wrapper_, deliberately, so the golden surface is stable.
- `npm run review:ledger -- stage ... --json '<json>'` fails under PowerShell
  when the JSON is written inline with single quotes; build the object with
  `ConvertTo-Json -Compress` and pass the variable instead.

## Follow-ups

- `promoteExactCandidate` appears to have no live caller (grep found only its
  definition). Removing it is out of scope here but worth a cleanup pass.
- The accepted residual: if `main` is positively red **and** the maximal
  composite genuinely fails, the train stops isolating, so a genuinely-broken
  queued PR sits in the queue instead of being ejected until `main` goes green.
  A probe-only validation of prefix 1 would resolve it but adds a second
  validation mode; deferred deliberately (plan-review suggestion 5, declined).
