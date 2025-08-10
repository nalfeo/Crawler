# Handoff — fix(ai): legacy BT hunt-fixation deadlock in updateEngageWatchdog

## Summary

Investigation-turned-fix for 3 of the 8 timeout/stall cases diagnosed in the authoritative
600-run Floor 1 weapon sweep (GitHub Actions run 29453994290, head `9ef7730f`, 100 seeds ×
6 weapons, 585/600 victories, 6 timeouts + 2 stalls). This session targeted the default
`pathingMode: LEGACY` / `decisionMode: LEGACY` AI (`BehaviorTreeAI` in
`src/game/ai/bt-ai-provider.ts`) per explicit instruction to fix root causes in the legacy
system first ("if we can fix it in the old system, the new systems will have to prove
their worth"). A sibling session is addressing the same repro cases in the newer AI decision
modes; another sibling session owns a separately-scoped "intelligent weapon kiting" feature.

**Root cause (proven via isolated A/B repro, not just plan-time hypothesis):**
`updateEngageWatchdog()`'s progress-tracking baseline (`engageBestDistance`, `engageBestHp`,
`engageNoProgressFrames`) was reset every time the tracked enemy `eid` changed frame-to-frame
(via a `private engageTargetEid` field). When 2+ enemies sat at nearly-identical distance from
the player, the BT's nearest-enemy target selection flickered between them every tick, wiping
the no-progress counter on every flip — so it could **never** reach `ENGAGE_GIVEUP_FRAMES` and
the AI stayed locked in a hunt/kite loop indefinitely. This was the dominant root cause behind
`bow-seed91`, `throwing-knife-seed14`, and `throwing-knife-seed18` (3/6 diagnosed repro cases;
confirmed via isolated repro re-runs, not the original conflated validation — see
"Post-implementation correction" below).

**The fix:** removed the `engageTargetEid` field and its eid-change reset block entirely, so
the baseline now persists correctly across a flickering target and eventually reaches giveup
as intended.

## Post-implementation correction (important)

The original plan review approved **two** candidate fixes:

- **Fix A** — health-gate the unbounded-radius Hunt/LeaveSafeRoom tutorial-grind override.
- **Fix B** — repair `updateEngageWatchdog()`'s eid-churn reset (the fix described above).

Initial validation conflated both fixes' effects. Isolated A/B repro testing (re-running each
fix independently against all 6 diagnosed cases) showed **Fix A had zero measurable effect on
any case** and **Fix B alone resolves bow-91/tk-14/tk-18**. Fix A was fully reverted; **the
shipped diff is Fix B only.** The review ledger's `plan_review` stage notes this correction
explicitly.

## Two additional bugs found and fixed via code review (same bug class)

Removing the eid-change reset block exposed that it had been implicitly covering two _other_
target-abandonment transitions as a side effect (next frame's new eid always differed from the
abandoned one, tripping the reset). Neither transition had its own explicit baseline reset:

1. **Death/despawn branch** (found in code-review round 1): when the tracked enemy's `hp <= 0`
   or its position vanishes, the function returned after resetting only
   `engageNoProgressFrames`, not `engageBestDistance`/`engageBestHp`. A freshly-tracked enemy
   after a kill could inherit an unreachably tight bar from the kill it replaced. Fixed by
   adding explicit resets to `Number.POSITIVE_INFINITY` for both fields in that branch.
2. **Giveup/blacklist branch** (found in code-review round 2, same bug class): when
   `engageNoProgressFrames > ENGAGE_GIVEUP_FRAMES` fires and the enemy is blacklisted
   (`targetEid = null`), the same gap existed. Fixed the same way.

A third, final code-review round (round 3) independently enumerated every early-return/branch
in `updateEngageWatchdog()` and confirmed all remaining transitions correctly reset all three
baseline fields (the "progressed" branch intentionally resets only the counter, since the
distance/hp fields were just tightened to better values in that same call — not a bug). Round
3 reported **clean, no concerns**.

## Changes

### `src/game/ai/bt-ai-provider.ts`

- Removed `private engageTargetEid: number | null = null;` field and all its assignment sites.
- Removed the `if (eid !== this.engageTargetEid) { ...reset baseline... }` block inside
  `updateEngageWatchdog()` — this is the core fix.
- Added a doc-comment on `updateEngageWatchdog()` explaining the churn-persistence rationale
  with repro citations.
- Death/despawn branch now also resets `engageBestDistance`/`engageBestHp` to
  `Number.POSITIVE_INFINITY`.
- Giveup/blacklist branch now also resets `engageBestDistance`/`engageBestHp` to
  `Number.POSITIVE_INFINITY`.

### `tests/game/behavior-tree-ai.test.ts`

- New test: "persists the ENGAGE no-progress baseline across a flipping nearest-enemy target"
  — two enemies at identical distance/HP, flips the tracked target every frame, confirms
  `engageNoProgressFrames` persists through the flips and eventually trips giveup; also asserts
  `engageBestDistance`/`engageBestHp` reset to `Number.POSITIVE_INFINITY` immediately after
  giveup fires (covers the giveup-branch fix).
- New test: "resets the ENGAGE progress baseline when the tracked target dies" — establishes a
  tight baseline against one enemy, kills it, confirms the baseline resets to Infinity before a
  fresh, more-distant enemy correctly registers as "progress" (covers the death-branch fix).
- Both tests were verified to actually catch their respective regressions by temporarily
  reintroducing the old buggy logic, confirming the test fails, then reverting.
- Added `type AIStateValue` import (needed for the private-internals-cast test harness type
  annotation; `AIState` is a const value object, not a type).

## Deferred (explicitly out of scope for this fix)

- `sword-seed14`: root cause is that `updateEngageWatchdog`'s `playerInSafeRoom` bypass has no
  timeout of its own — a separate, unrelated defect. Not touched here.
- `bow-seed54` / `pistol-seed23`: multi-threat kiting gap — assigned to the sibling
  "intelligent weapon kiting" session.
- The remaining timeout/stall cases and PR #1147 slow-victory-classification interaction were
  covered by the original investigation report to the creator session; no further action here.

## Verification

- `npm run typecheck` — clean.
- `npx vitest run tests/game/behavior-tree-ai.test.ts` — 101/101 pass.
- `npm run verify:fast` — 195 tests across 12 unit test files, all green.
- Regression tests independently confirmed to catch their target bugs (sabotage-and-revert
  method).
- 3-round code-review loop completed; round 3 clean. See
  `docs/knowledge/review-ledgers/2026-07-16-fix-legacy-hunt-fixation.review-ledger.json`.

## Systems touched

ai-behavior-tree

## Apples

🍎🍎🍎 estimated, 🍎🍎🍎 actual — grew somewhat from the two code-review-discovered baseline-reset
bugs (same fix pattern, low incremental complexity), but stayed within the original tier.

## Unresolved issues

- Coordinate with the sibling "Intelligent weapon kiting" session (this file's diff touches
  `bt-ai-provider.ts`, which has seen heavy concurrent upstream activity — branch was 37 commits
  behind `origin/main` before being rebased mid-session).
- `sword-seed14` (safe-room-bypass-needs-timeout) remains unfixed — separate root cause, no
  fix proposed yet.
