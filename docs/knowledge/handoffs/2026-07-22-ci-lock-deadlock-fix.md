# Session Handoff: Durable fix — prevent ci-owner lock deadlock

## Date

2026-07-22

## Persona

Writer (CI-automation tooling)

## Systems touched

ci-policy

## Apples

4🍎 estimated, 4🍎 actual. Full JSON summary: `docs/knowledge/metrics/apples/2026-07-23-ci-lock-deadlock-fix.json`.

Re-scoped from the author's original 3🍎 to 4🍎 under the coordinator's **Option A** mandate:
keep ownership and fully harden the reaper lane (adversarial plan review + multi-model review),
rather than shipping the minimal 3-fix version. The 4🍎 review harness is recorded in
`docs/knowledge/review-ledgers/2026-07-22-ci-owner-lock-deadlock-fix.review-ledger.json`.

## What Was Done

Fixed three independent root causes that combined to produce a CI-owner lock deadlock where 10/11
`ci-owner-pr-*` locks were held with no active Copilot session (two for 12.7h).

**Fix A (lease-reaper lane — break budget-starvation deadlock):**

- Added `identifyReapablePrs(scheduledPulls, now)` to `router.mjs`. Identifies automation-owned PRs
  with state older than `AUTOMATION_STALE_MINUTES` (30 min) _and_ owner-labeled PRs with
  `recoveryStateUnreadable` set.
- Added `REAPER_LANE_CAP=2` exported constant — reserved dispatch slots that are NOT counted against
  `computeDispatchBudget`, so GC can never be starved to zero.
- Added a reaper pass in `runFromEnv` that runs on every `schedule`/`workflow_dispatch` event before
  the normal budget calculation. It:
  1. Hydrates all owner-labeled PRs still missing `recoveryState` (covers train-mode partial hydration
     stops AND non-train mode where no hydration runs).
  2. Dispatches up to `REAPER_LANE_CAP` stale PRs with `trigger=lease-reaper`.
  3. Records dispatched PR numbers in `reaperDispatchedSet`, then filters those from the normal
     `prNumbers` result after `collectPrNumbers()` — preventing double-dispatch.

**Fix B (422 crash wedge — make release() unreachable-proof):**

- Wrapped the `POST /pulls/{n}/comments/{id}/replies` call in `reconcile.mjs` (~line 1155) in
  try/catch. On 422 or any API error: logs to stderr, logs skip to stdout, and `continue`s. This
  prevents a dangling CI-PAT pending review from crashing reconcile before `release()` runs.
  The synthetic trusted marker is NOT injected on failure, so `shouldResolveThread` is not
  falsely triggered.

**Fix C (TTL becomes a true wall-clock ceiling — adopted design; adversarial plan review = DIVERGENT):**

- The **original** Fix C proposed a session-liveness signal: infer "session is live" from
  `workflow_runs` on the PR head SHA and only hard-release when no live run exists. The
  **adversarial plan review (rubber-duck, `gpt-5.6-sol`) REJECTED this as UNSAFE** (`plan_divergence:
major_fork`): unrelated CI / merge-train / sweep runs — and the reaper's OWN reconcile dispatch —
  share the head SHA, so the liveness check reads "live" forever → the lock becomes immortal (the exact
  deadlock being fixed). No reliable, attributable per-session liveness signal exists at reconcile time.
- **Adopted (no run-inference):** on the dedicated `trigger === 'lease-reaper'` GC dispatch, the
  stale-automation `retry` else-branch in `reconcile.mjs` **FREEZES `progressAt`** (does not refresh it)
  and **carries the `attempt` count** forward. The existing 2-attempt ceiling (`automationStallAction`,
  `AUTOMATION_STALE_MINUTES`=30) therefore becomes a **true ~30-min wall-clock ceiling** instead of a
  sliding window that resets on every reap. A dead lock is force-released within ≤3 sweeps regardless of
  any liveness guess (fixes the immortal-lock bug); a legitimately-busy >30-min session is bounded by the
  same ceiling — accepted as the safe default, since over-eviction is recoverable (fresh re-acquire)
  whereas an immortal lock is not.

**Reaper-lane hardening (Option A — 5 Copilot-reviewer findings, all fixed):**

- **#1** (`reconcile.mjs`): the freeze-`progressAt` + carry-`attempt` behavior above.
- **#2** (`router.mjs` `identifyReapablePrs`): hydrated `null` state (absent/malformed) is now reapable
  (`if (state === null) return true;`), ordered after the `recoveryStateUnreadable` short-circuit;
  `undefined` (unhydrated) still returns false.
- **#3** (`router.mjs`): extracted a pure exported `selectReaperBatch(reaperPrNumbers, now, cap)` that
  **stable-sorts by PR number** before `rotateList(...).slice(0, REAPER_LANE_CAP)`. The stable sort was a
  distinct HIGH finding from the multi-model review (`gemini-3.1-pro-preview`): GitHub's `updated_at desc`
  pull feed churns (a reap bumps a PR's `updated_at` to the front), so rotating the raw feed broke the
  cross-window fairness/anti-starvation guarantee. Sorting first makes the batch a pure function of the
  input SET + time window.

**Tests added:**

- `router.test.mjs`: unit tests for `identifyReapablePrs` (stale detection, healthy skip,
  shepherd skip, REAPER_LANE_CAP caller slicing, progressAt vs updatedAt priority, unreadable state
  included), plus reaper-hardening additions: hydrated-null-vs-undefined reapability (#2); a load-bearing
  `selectReaperBatch` order-independence assertion + cross-window coverage (#3, verified to FAIL without
  the stable sort, so non-vacuous); and a subprocess `runFromEnv` sweep test (#5) proving a
  zero-budget `trigger:lease-reaper` dispatch fires for a stale PR and that the reaped PR is excluded
  from the normal dispatch loop.
- `reconcile.test.mjs`: the 422-marker-reply regression, plus a variant modeling an attached stale
  automation owner that asserts the ownership fence is released/advanced after the 422 while exiting 0
  (#4), and a lease-reaper freeze test proving `progressAt` is frozen + `attempt` incremented (#1).

Observed in CI tooling context only (no runtime game changes). No `npm run dev` observation
required — this is a CI-automation script change.

## Key Decisions Made

- **Reaper runs BEFORE budget, not inside it.** The only way to ensure GC never competes with normal
  dispatch for budget is to run it as a separate prior pass. Any approach that decrements the budget
  by REAPER_LANE_CAP still starves GC when outstanding count ≥ (cap − REAPER_LANE_CAP).
- **Targeted try/catch instead of `finally { release() }`** around the entire reconcile. A crash
  mid-run may have left partially-committed labels; wrapping everything in a finally release() could
  release a lock that a concurrent run already reclaimed. The targeted try/catch is safer.
- **Unreadable-state PRs included in reaper.** PRs where state comment read failed are just as stuck
  as expired-automation ones — reconcile can only help if dispatched. Including them in the reaper
  batch gives the reconciler's orphan-cleanup path a chance to run.
- **Double-dispatch exclusion via set subtraction.** Simplest approach: collect `reaperDispatchedSet`,
  then `prNumbers.filter(n => !set.has(n))` after `collectPrNumbers()`. No changes to
  `collectPrNumbers` or `partitionDispatchable` needed.

## What's Next / Blockers

- PR #1784 ready for review / auto-merge.
- Related follow-ups (tracked in separate issues): #1778 (load-aware budget — reaper lane formally),
  #1779/#1780 (CI knobs audit — TTL/cap/reaper cadence runtime-tweakable), #1762 (CI health
  dashboard — max lock age surfaced).

## Retrospective

### Lessons Learned

- The plan review (gpt-5.4) caught three blocking bugs before the code review: double-dispatch,
  train-mode partial hydration, and unreadable-state blindspot. Running plan review early on
  CI-automation logic is worth the cost.
- The code review (claude-opus-4.8) caught a failing test: the Fix B regression test missed
  the `suggestedActors` GraphQL handler, so reconcile crashed in the assignment path and the
  test would have been red in CI. Mock-server tests need to cover the full reconcile happy path
  after the tested failure, not just the failure itself.

### Mistakes Made

- Initially skipped train-mode partial hydration, assuming "train mode already hydrates". Train
  hydration stops early at `targetDispatchable` — so owned PRs beyond the repair window are still
  unhydrated. The reaper must hydrate unconditionally.
- Initially skipped `recoveryStateUnreadable` PRs — only stale active-state PRs were targeted.
  Any owner-labeled PR that can't be fully read is equally stuck.
- In the Fix B regression test, only `resolveReviewThread` and `enablePullRequestAutoMerge`
  GraphQL mutations were mocked. The `suggestedActors` query and `replaceActorsForAssignable`
  mutation that come later in the reconcile flow were missing, causing exit 1 in CI.

### Opportunities for Future Improvement

- Add a deterministic integration test that runs the reaper path end-to-end, verifying that
  `reaperDispatchedSet` correctly prevents the double-dispatch at the router level.
- Consider adding `REAPER_LANE_CAP` and `AUTOMATION_STALE_MINUTES` to the CI knobs audit (#1779)
  so they're runtime-tweakable without a code change.
- Explore adding a `finally { release() }` safety-net scoped narrowly to the ownership-claim
  section of reconcile (not the whole script) to further harden the release path.
