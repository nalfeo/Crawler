# Handoff: Pre-exit XP sweep + RunStats xpOnGroundAtEnd telemetry

**Date:** 2026-08-01
**Persona:** Game AI Engineer
**Apples:** 3 estimated, 3 actual
**PR:** Closes #2585

## Systems touched

ai, headless-runner, bt-ai, run-stats

## Problem solved

The headless AI runner collected only 38–60% of spawned XP. Root cause: after
the staircase unlocks, `buildProgressBehavior()` (Priority 3) routes the AI to
the stairs each frame. `buildCollectBehavior()` at Priority 5 never wins because
Progress always finds a valid staircase objective. XP gems outside the 50 ft
scan radius are never collected. At floor transition, uncollected gems are
permanently destroyed (fresh entity world on scene restart).

Additionally, `RunStats` had no `xpOnGroundAtEnd` telemetry, so collection
efficiency was not measurable from normal run output.

## Changes

### `src/game/ai/bt-ai-provider.ts`

Added a **Pre-exit XP Sweep** behavior node at Priority 2.5 (between Interact=2
and Progress=3). After the floor staircase is unlocked but before it is
discovered, the AI sweeps all remaining reachable XP gems before descending.

Key design:
- **XP-only** — avoids long detours for gold/items post-clear
- **Dedicated target latch** (`xpSweepTargetEid`) — re-validates the existing
  target each frame, rescans only when the gem is gone or unreachable. Prevents
  per-frame re-sort of all XpGem entities (zig-zag).
- **Panic gate** (`XP_SWEEP_PANIC_THRESHOLD = 0.5`) — sweep aborts if
  `panic > 0.5` or `beeline` active (Floor 1 deadline pressure)
- **Enemy gate** — sweep disabled when any enemy is within `getEngageRadius()`
- **Floor 1 guard**: `staircaseUnlocked && !staircaseDiscovered`
- **Floor 2 guard**: same as `autoFloor2ProgressionSystem`: `staircaseUnlocked &&
  staircaseSpawned && !staircaseDiscovered && staircasePos != null`
- **Unlimited radius** — no `scanRadius` cap during sweep phase
- **Reachability** — `isLootCollectable()` still applied (impassable gems skipped)

New private members:
- `xpSweepTargetEid: number | null` — sticky latch, reset in `reset()`
- `isFloorClearedAwaitingSweep(world)` — sweep window predicate
- `findNearestXpGemForSweep(world, px, py)` — full-floor scan with latch
- `buildPreExitXpSweepBehavior()` — BT node at Priority 2.5

### `src/game/ai/bt-ai-tuning.ts`

Added `XP_SWEEP_PANIC_THRESHOLD = 0.5` constant with explanation comment.

### `src/game/ai/types.ts`

Added `xpOnGroundAtEnd?: number` to `RunStats` interface. Combined with
`totalXp`, callers can now compute `xpOnGroundAtEnd / (totalXp + xpOnGroundAtEnd)`
as the collection-efficiency ratio without bespoke instrumentation.

### `src/game/ai/headless-runner.ts`

- Imported `XpGem` from `src/core/index.js`
- Computed `xpOnGroundAtEnd` at run end by querying all `[XpGem]` entities and
  summing `world.stores.xpGem.value[eid]`
- Added `xpOnGroundAtEnd` to both the normal stats path and the crashStats path

### `tests/unit/ai/bt-pre-exit-xp-sweep.test.ts` (new)

4 unit tests:
1. Sweep fires and targets the XP gem when floor cleared + gems on ground
2. Falls through to Progress when no XP gems remain
3. Does NOT fire when staircase still locked (floor not yet cleared)
4. Does NOT fire when staircase already discovered (player already descending)

### `docs/knowledge/review-ledgers/2026-08-01-xp-sweep-floor-exit.review-ledger.json`

3🍎 review ledger: plan_review (gpt-5.4, 4 concerns → 4 resolved, plan_divergence: minor) + code_review (claude-sonnet-5, clean).

## Why this matters

At 100% XP collection the same Floor 2 runs reach level 13–15 instead of the
observed 10–12. Any boss/difficulty tuning calibrated against AI-observed player
level was tuned against a weaker player than a real one. This fix makes the AI a
more representative proxy for competent human play.

## Caveats

- The sweep is a behavior-level fix, not a physics/attraction fix. Gems very
  close to impassable geometry that fail `isLootCollectable()` are still skipped
  (exactly 1 gem across all 6 measured runs, consistent with issue data).
- Floor 1 deadline pressure (`panic > 0.5`) will abort the sweep; the AI still
  prioritizes not dying or missing the collapse deadline over XP efficiency.
- The fix does not address the TTL-less gem design — gems still have no expiry
  component, but that is intentional (human players collect them too).
