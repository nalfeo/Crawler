# Handoff — Harden abortable `sleep()` with a post-registration re-check

**Date:** 2026-07-02
**Slug:** harden-abortable-sleep
**Branch:** nalfeo-harden-abortable-sleep
**Persona:** Producer

## Apples

**Estimated: 🍎🍎 (2, Small).** 1–3 files, a simple bug-hardening plus a test
suite, no lab. Requires a `plan_review` stage in the review ledger. See
`## Calibration` below for the actual.

## Summary

Small follow-up to PR #662 (the sprite asset-request poison-loop + bad-grid
fix). A late Copilot PR reviewer flagged a theoretical `AbortSignal` race in the
`sleep()` helper in `scripts/sprites/worker.ts`: the signal could be aborted
between the initial `if (signal?.aborted)` guard and the `addEventListener('abort', …)`
registration, in which case the `{ once: true }` listener would never fire and
the promise would only resolve after the full `ms`.

The flagged race is a **false positive for the code as written** — the guard,
`setTimeout`, and `addEventListener` all run inside one **synchronous** Promise
executor with no `await`/yield, so Node's single-threaded loop cannot interleave
`abort()` between the guard and the registration. #662 merged with the reviewer
thread owner-resolved on that basis.

This change lands the reviewer's **literal suggested fix anyway** as cheap,
durable insurance: after registering the listener, re-check `signal.aborted` and,
if it flipped, remove the listener, clear the timer, and resolve immediately.
This closes the (currently-unreachable) window and hardens the abort contract
against any future refactor that introduces an `await` between the guard and the
registration. `sleep()` is exported so it can be unit-tested directly.

## Files touched

- `scripts/sprites/worker.ts` — `export` the `sleep()` helper; add a
  belt-and-suspenders `if (signal?.aborted) { removeEventListener; clearTimeout; resolve; }`
  re-check immediately after `addEventListener`. Behavior-preserving; no new deps.
- `tests/unit/sprites/worker.test.ts` — new `describe('sleep (abortable)')` with
  two deterministic regression tests: (1) an already-aborted real
  `AbortController` resolves immediately; (2) a fake signal that reports
  `aborted` only **after** listener registration resolves via the new re-check.
  Test 2 tracks registration order (`registered`/`reCheckObserved`) so only the
  post-registration re-check can satisfy it, and asserts prompt settlement via a
  microtask-sentinel race under fake timers (no reliance on a 60s timeout).
- `docs/knowledge/review-ledgers/2026-07-02-harden-abortable-sleep.review-ledger.json`
  — 2🍎 ledger with the `plan_review` stage.
- `docs/knowledge/metrics/apples/2026-07-02-harden-abortable-sleep.json` — apple
  calibration entry.

**No ADR and no lab** — the change lives entirely under `scripts/`, touches no
`src/core|engine|game` layer and no `src/core/systems|src/labs`, so the
cross-system-ADR and lab gates do not apply. This also keeps it clear of the
sibling queue-visibility session's ADR 0039 / adr/README.md.

## Review harness (2🍎 → plan_review)

A genuine **separate-model plan review** (gpt-5.4; the implementer is Claude
Opus, so this is a real cross-family review) assessed the hardening and tests.
Verdict: implementation correct, no regression (idempotent `resolve`, no
listener or timer leak, cleanup ordering fine), reviewer race confirmed a false
positive for the synchronous executor, and the re-check is the right minimal
no-deps hardening. It raised **1 non-blocking concern** — test 2 did not
strictly pin resolution to the post-registration re-check and regression-failed
only via a slow 60s timeout. **Resolved** by rewriting test 2 as described above.
Recorded in the ledger as `plan_review` (concerns 1 / resolved 1); ledger
`validate` passes.

## Verification run

- `npx vitest run tests/unit/sprites/worker.test.ts` → 17/17 pass (incl. the two
  new sleep tests).
- `npm run review:ledger -- validate <ledger>` → ✅ valid 2-apple ledger.
- `npm run verify` (full) → green (see PR).

## Unresolved issues

None for this change. The re-check path is behaviorally unreachable in today's
synchronous executor (by design), so it is a no-op at runtime; its value is the
regression tests locking the abort contract for future refactors.

## Recommended next steps

- None required. This is a self-contained hardening follow-up.
- If a future change ever introduces an `await` inside the `sleep()` executor
  between the guard and `addEventListener`, the re-check + test 2 already cover
  the resulting real race.

## Calibration

**Actual: 🍎🍎 (2). Delta 0 → 🎯 exact.** Landed as scoped: a 2-file
hardening + test suite with a real separate-model review that surfaced and
resolved one test-quality concern, plus ledger/handoff/metrics. No scope
surprises.
