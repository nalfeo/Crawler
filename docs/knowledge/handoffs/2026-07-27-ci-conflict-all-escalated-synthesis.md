# Handoff: CI conflict coordinator — all-escalated cluster synthesis path

**Date:** 2026-07-27  
**Session slug:** ci-conflict-all-escalated-synthesis  
**Apple estimate:** 2🍎  
**Closes:** nalfeo/Crawler#2095

## Systems touched

ci-automation, ci-conflict-coordinator

## Summary

The CI conflict coordinator previously stalled indefinitely when every blocking
PR in a conflict cluster received an `ambiguous` supersession proof (the
all-escalated state). Each scheduled sweep (every 5 min) would re-label members
with `ci-conflict-order-wait` + `ci-conflict-escalation` and record an escalation
comment, but no progress was made and a maintainer had to intervene manually.

This session adds the executable recovery path described in issue #2095 and ADR
0067's Failure and Recovery Boundaries section.

## What changed

### `.github/scripts/ci-conflict-coordinator/state.mjs`

New exports:
- `SYNTHESIS_LABEL = 'ci-conflict-synthesis'` — label for created synthesis issues.
- `SYNTHESIS_LEASE_MS = 4 * 60 * 60 * 1000` — 4-hour synthesis dispatch lease.
- `isAllEscalated(proofs)` — predicate: all proofs in the array have `status='ambiguous'`.
- `computeSynthesisKey({ groupId, ambiguousEntries })` — deterministic fingerprint
  over `{groupId, [{number, headSha}]}` so any membership or force-push change
  produces a new key and allows re-dispatch.
- `shouldDispatchSynthesis({ priorSynthesisKey, nextSynthesisKey, synthesisDispatchAt, now })`
  — mirrors the existing `shouldDispatchActiveSlot` dedup + lease logic.

`makeCoordinatorState` gains four new optional fields (null by default,
backward-compatible with all existing persisted states):
- `synthesisDispatchKey` (string|null)
- `synthesisDispatchAt` (string|null)
- `synthesisIssueNumber` (number|null)
- `synthesisSupersededPrs` (number[]|null)

`validateCoordinatorState` validates the new optional fields when present.

`renderCoordinatorComment` renders a `### Clean-room synthesis` section when
`synthesisDispatchKey` is set, listing the dispatch timestamp, issue number, and
superseded PRs.

### `.github/scripts/ci-conflict-coordinator/reconcile.mjs`

- Imports `SYNTHESIS_LABEL`, `isAllEscalated`, `computeSynthesisKey`,
  `shouldDispatchSynthesis` from `state.mjs`.
- `SYNTHESIS_LABEL` added to the `ensureLabel` setup block.
- New async function `createSynthesisIssue(group, mainSha, ambiguousPulls)` —
  POSTs a `ci-conflict-synthesis`-labelled GitHub issue via the coordinator token.
  The issue body includes: cluster ID, PR numbers + titles to supersede, shared CI
  file overlap, current main SHA, and action instructions.
- In the main group reconcile loop, after the existing ci-recovery dispatch block:
  1. Computes `allEscalated = isAllEscalated(proofs)`.
  2. If all-escalated: computes `nextSynthesisKey`, reads prior synthesis state from
     `priorStates[0]`, dispatches synthesis if `shouldDispatchSynthesis` is true,
     otherwise logs `synthesis-active`.
  3. If not all-escalated: resets synthesis fields to null so a future all-escalated
     transition gets a fresh dispatch.
- `makeCoordinatorState` calls updated to pass synthesis fields.

### Tests

**`state.test.mjs`** — 19 new unit tests covering:
- `isAllEscalated` (empty, mixed, all-ambiguous)
- `computeSynthesisKey` (stability, head-SHA change, group-ID change)
- `shouldDispatchSynthesis` (null key, first dispatch, key change, lease active,
  lease expired)
- `makeCoordinatorState` synthesis round-trip, null defaults, validation rejection
- `renderCoordinatorComment` synthesis section presence/absence

**`reconcile.test.mjs`** — 2 new integration tests:
- `setupGitReposAllAmbiguous` git fixture: all 3 PRs branch from base and change
  the same line that main advanced, so every squash-merge produces a conflict →
  all `ambiguous`.
- Test 13: "coordinator creates exactly one synthesis issue for an all-ambiguous
  cluster" — verifies exactly one `POST /issues`, correct label, PR references in
  body, `dispatched-synthesis` log, no ci-recovery dispatch.
- Test 14: "coordinator does not re-dispatch synthesis when prior state has active
  lease" — runs reconcile twice; second run with prior state carrying the matching
  `synthesisDispatchKey` and a recent `synthesisDispatchAt` produces zero new issue
  creations and logs `synthesis-active`.

**`characterization/verdict-fixtures.json`** — CC05 fixture for
`shouldDispatchSynthesis` (first-dispatch case).

**`characterization.test.mjs`** — handles new `shouldDispatchSynthesis` fixture
kind; count assertion updated 4 → 5.

## Acceptance criteria addressed

| Criterion | How addressed |
|---|---|
| Deterministic fixture reproduces all-ambiguous cluster, proves exactly one synthesis transition | `setupGitReposAllAmbiguous` + reconcile.test.mjs test 13 |
| No redispatch of order-waiting originals while synthesis is active | reconcile.test.mjs test 14 |
| Replacement task based on current `main`, excludes contaminated commits | `createSynthesisIssue` body instructs implementors; synthesis key computed from current main-relative state |
| Sticky state names owner, lease, source cluster, superseded PRs | `synthesisDispatchKey/At/IssueNumber/SupersededPrs` in coordinator state |
| Successful replacement merge clears cluster | Existing `closeDuplicate` logic handles this once replacement lands on main and supersedes originals |
| Production observation | Will occur naturally on next all-escalated cluster hit |

## Test counts

- state.test.mjs: 47 pass (was 28)
- reconcile.test.mjs: 14 pass (was 12)
- characterization.test.mjs: 2 pass (unchanged)
