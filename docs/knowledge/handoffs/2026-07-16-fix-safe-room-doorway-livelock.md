# Session Handoff: Fix Floor 1 safe-room doorway livelock (timeout bucket)

## Date

2026-07-16

## Persona

Systems Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

3🍎 exact (`docs/knowledge/metrics/apples/2026-07-16-fix-safe-room-doorway-livelock.json`)

## What Was Done

Addressed the **second-largest failure bucket** (`outcome=timeout`, 14/95 failures, 14.7%) from
the official Floor 1 600-run cloud sweep (GH Actions run 29477221792, main SHA
`7974d2ec998db69213ffee1b0ff18ae16bbd2922`).

**Reproduction on current main (HEAD `b6bca40f`) before any change**: re-ran all 14 canonical
timeout pairs headless. Only **4 still reproduce as TIMEOUT**: `bow@54`, `bow@91`, `sword@14`,
`baseball-bat@35`. The other 10 had already resolved (VICTORY/DEATH) via unrelated upstream fixes
since the sweep SHA.

**Root cause** (fully instrumented and confirmed on `sword@14`, then reverted): a frame-perfect
AI livelock at safe-room exit doorways. `world.playerInSafeRoom` (`src/core/safe-space.ts`) is a
coarse, single-tile-boundary flag recomputed every frame. `buildLeaveSafeRoomBehavior`'s
behavior-tree condition (`src/game/ai/bt-ai-provider.ts`) used to bail out (`return false`) the
instant that flag went false for even one frame — even mid-flight toward an already-committed
egress waypoint. That handed control to the much-lower-priority `Hunt` behavior, which steered
toward a different target and pulled the player back across the doorway boundary, re-arming
`LeaveSafeRoom` — an infinite frame-perfect oscillation with zero net progress. Confirmed via
direct frame-by-frame instrumentation of `movementSystem.ts` (always `fullPassable:true` — this is
**not** a collision/pathing bug) and of the AI's decision output (`decision.reason` alternating
every single frame between `"Leaving safe room..."` and `"Hunting enemy..."`). This exact flicker
class is already named elsewhere in the codebase (`bt-ai-tuning.ts`'s
`QUEST_GIVER_DETOUR_COMMIT_HYSTERESIS` comment), confirming precedent for a hysteresis-style fix.

**Fix**: once an egress is already committed (`safeRoomEgressTargetX/Y !== null`), a momentary
`playerInSafeRoom === false` no longer instantly cedes control. The commitment persists until
either it arrives at the waypoint, the existing no-progress watchdog trips, or the
**pre-existing** `updateSafeRoomEgressWaypointLatch`/`SAFE_ROOM_EGRESS_EXIT_HYSTERESIS_FRAMES`
(30-frame) latch — already in the codebase, unmodified — clears the target after genuinely being
outside for that many consecutive frames. Starting a brand-new egress still strictly requires
genuinely being inside the safe room. A second, smaller fix (found in code review, see below)
corrects an interaction where the no-progress watchdog's 120-frame suppress cooldown could be
zeroed one frame after firing if it fired while the player happened to be outside — a state
newly reachable because of the primary fix.

Observed in the headless AI-runner CLI (real runtime wiring, `SeededRandom`, no mocks):

- `sword@14`: TIMEOUT (330s) → **VICTORY (14.7s)**
- `bow@91`: TIMEOUT (330s) → **VICTORY (17.8s → ~16.2s w/ final fix)**
- `baseball-bat@35`: TIMEOUT (330s) → **VICTORY (~18.8s w/ final fix)**
- `bow@54`: still TIMEOUT, but progresses far further (L0→L6, boss-battle accepted, 36+ kills)
  before running out of budget — telemetry (56% EXPLORE / 28% RETREAT, final HP 9.2%, no
  oscillating-decision-reason signature) indicates a **distinct combat/survival-pacing issue**,
  not a navigation livelock. Out of scope here (would require balance-adjacent changes needing
  human approval). **Flagged as a follow-up.**

## Key Decisions Made

- **Scoped the fix to `buildLeaveSafeRoomBehavior`'s condition only**, not `safe-space.ts`'s
  `isPointInSafeSpace`/`playerInSafeRoom` itself — that flag is read by other systems (weapon-disable
  gate, equipment/customization UI), so debouncing it directly would have a much larger blast
  radius than necessary. This keeps the diff to one file (`bt-ai-provider.ts`) plus its test file.
- **Relies on the pre-existing `SAFE_ROOM_EGRESS_EXIT_HYSTERESIS_FRAMES` (30-frame) latch** rather
  than inventing a new bound. Plan review (gpt-5.4, adversarial-lite) flagged the initial version's
  blast radius as under-described and asked for either a narrower window or threat revalidation
  before continuing outside. A revalidation variant (early hand-off to Engage once outside with an
  enemy already in engage range) was tried and **reverted**: it fixed two control flips but flipped
  `bow@91` — one of the 4 required repros — from VICTORY back to DEATH, failing the hard gate that
  all confirmed repros in the panel become victories. The merged version trusts the existing,
  already-designed 30-frame latch instead.
- **Code review (round 1, claude-sonnet-4.6)** found one real, valid, non-blocking bug this fix
  exposed: the `!playerInSafeRoom && !hasCommittedEgress` guard was unconditionally zeroing the
  no-progress/max-active watchdog's 120-frame suppress cooldown one frame after it fired, if the
  watchdog tripped while genuinely outside (impossible pre-fix). Fixed by removing the redundant
  zero-write; Guard 2's countdown already only consumes the counter while genuinely inside, so
  leaving it untouched while outside just preserves the cooldown instead of collapsing it.
  **This correction incidentally also resolved two of the worst control-set findings** (see below).
  Round 2: clean, no further concerns.
- **Corrected a control-set bookkeeping error** caught in plan review: 3 of my original 16
  "regression control" seed/weapon pairs were actually members of the original 14-pair evidence
  set (already resolved on baseline main to a non-timeout outcome via unrelated upstream fixes),
  not independent controls — `pistol@23`, `throwing-knife@6`, `throwing-knife@18`. Re-verified with
  correct labeling; see Retrospective for the corrected final tally.
- Added a dedicated regression test (`tests/game/behavior-tree-ai.test.ts`) reproducing the
  sword@14 root cause at unit-test granularity (a 6-poll `playerInSafeRoom` true/false oscillation
  that must not drop the committed waypoint), and updated one pre-existing test that encoded the
  old, buggy instant-release semantics.

## What's Next / Blockers

1. **Dispatch the GitHub Actions Weapon Sweep workflow** with the same configuration as the
   canonical evidence run (seeds 1-100 × six weapons, `weapon_personas=true`, `max_frames=19800`,
   600 runs) for the authoritative category-level delta against the 505 victories / 95 failures
   baseline, per the task's own instructions ("use the GitHub Weapon Sweep workflow for any
   broader validation"). Not yet dispatched as of this handoff — do this before merging, and report
   the resulting timeout-bucket size + overall split back to the originating triage session.
2. **`bow@54`** still times out — confirmed a **distinct**, combat/survival-pacing issue (not a
   navigation livelock: no oscillating-decision signature, dramatically more progress than before
   this fix). Flag for a follow-up session; do **not** force-fix here without explicit human
   approval (would likely touch retreat thresholds / combat difficulty, which is balance territory).
3. **`throwing-knife@4`** (a true control, not an evidence pair) flips VICTORY (baseline) → DEATH
   (fixed) — the one remaining unexplained flip out of 16 controls tested. Not a new failure
   category (DEATH already exists), consistent with the documented deterministic-chaos
   butterfly-effect of changing per-frame AI decision logic that runs at the start of every
   Floor-1 run. Disclosed transparently rather than masked; the GH Actions sweep is the intended
   arbiter of net category-level impact.
4. If the sweep confirms the fix nets a clear improvement to the timeout bucket with no new
   systemic failure class, proceed to `gh pr merge --auto --squash` per repo auto-merge policy.

## Retrospective

### Lessons Learned

- The headless AI-runner CLI (`npx tsx src/game/ai/headless-runner-cli.ts --seed N --weapon W
--max-frames 19800 --weapon-personas`) plus `git stash`/`git stash pop` around a fix is a fast,
  reliable way to A/B a single seed/weapon pair against baseline main without needing a full CI
  sweep for every iteration — used dozens of times this session to narrow down the root cause and
  validate fixes.
- When investigating an AI decision oscillation, instrumenting the _decision output_ (`decision.reason`
  alternating every frame) alongside raw movement/collision state was what actually pinned the bug —
  collision instrumentation alone (`fullPassable`, `blockedDiagonalCorner`) only proved what
  _wasn't_ the cause; it took correlating decision-reason changes frame-by-frame with position
  oscillation to see the two systems (LeaveSafeRoom vs Hunt) fighting over control.
- A pre-existing code comment elsewhere in the same file family
  (`QUEST_GIVER_DETOUR_COMMIT_HYSTERESIS` in `bt-ai-tuning.ts`) describing the _exact same class_ of
  bug in a different behavior was a strong, fast signal for the right fix shape (hysteresis on a
  committed in-flight state) — worth grepping sibling AI files for prior art before designing a fix
  from scratch.
- This codebase already has more hysteresis/latch infrastructure than a first read suggests: the
  `updateSafeRoomEgressWaypointLatch` method (with its own `SAFE_ROOM_EGRESS_EXIT_HYSTERESIS_FRAMES`
  constant) was _already implemented and already running every poll_, but the BT condition it was
  meant to support ignored it and bailed out immediately anyway — the actual bug was a
  short-circuit that made existing, well-designed infrastructure inert for this one transition.
  Worth checking whether "the fix already half-exists but isn't wired up" before adding new state.

### Mistakes Made

- **Miscounted the regression-control set.** Picked 16 "control" seed/weapon pairs to check for
  side effects, but didn't cross-check them against the original 14-pair evidence list first — 3
  of the 16 (`pistol@23`, `throwing-knife@6`, `throwing-knife@18`) turned out to already be members
  of that evidence set (already resolved on baseline main via unrelated upstream fixes), which
  initially made a real, dramatic _improvement_ (`pistol@23`: DEATH at L2/105s → nearly finishing
  the whole floor before timing out at the very last objective) look like a confusing new timeout
  regression before I traced it in full. **Fix for next time**: always diff any "control set" against
  the canonical evidence list _before_ running it, not after a reviewer catches the overlap.
- **First fix version was too broad, and I initially mischaracterized its bound as "one frame" in
  the writeup** when it actually persisted until arrival at a potentially-far overshoot waypoint
  (bounded only by the pre-existing 30-frame latch, which I hadn't yet traced to). A follow-up
  "narrow the window with threat revalidation" attempt then broke a _required_ repro (`bow@91`)
  that had been fixed under the broader version — a reminder that tightening a fix to satisfy one
  concern can silently violate a different, already-met hard requirement; each iteration needs the
  **full** repro + control panel re-run, not just the specific case the last round's feedback was
  about.
- Code review (not I) caught a real interaction bug the fix exposed (the suppress-cooldown zeroing
  issue) that I had not noticed despite multiple rounds of local A/B testing — a reminder that
  local outcome-level testing (VICTORY/DEATH/TIMEOUT) can silently pass even when an internal state
  machine has a latent, not-yet-triggered bug; a dedicated code-review pass on the actual guard
  logic (not just black-box outcomes) found something outcome testing alone did not.

### Opportunities for Future Improvement

- If a third instance of the "`playerInSafeRoom` flickers as the body straddles a boundary" bug
  class turns up anywhere else in the AI decision tree (this session found the second, after the
  pre-existing quest-giver-detour case), it's worth extracting a shared "committed/sticky objective
  survives a one-frame boundary flicker" helper instead of hand-rolling the pattern a third time —
  flagged by plan review as a non-blocking suggestion, not warranted yet for just two instances.
- `bow@54`'s remaining timeout (distinct combat/survival-pacing issue, not navigation) and
  `pistol@23`'s newly-visible "completes the whole floor but times out on the very last objective"
  near-miss (now itself resolved to VICTORY by this fix's second correction, but worth noting as a
  class of failure — "quest-complete-but-late", matching several of the _other_ original 14 pairs
  not touched by this fix) both suggest the floor's late-game pacing (final objective / floor-exit
  wayfinding, post-boss-battle) may be a worthwhile follow-up investigation area, separate from
  navigation/behavior-tree bugs — likely balance-adjacent and requiring explicit human scoping.
