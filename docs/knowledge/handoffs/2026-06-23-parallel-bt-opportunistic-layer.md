# Session Handoff: Parallel BT Opportunistic Layer

## Date

2026-06-23

## Persona(s) adopted

Game Designer (AI tuning + headless regression fix).

## Routing verdict

✅ right persona — task was cross-layer AI mechanic + game balance (headless budget).

## Apples

Estimated: 🍎 (1)
Actual: 🍎🍎 (2) — diagnosing the headless regression took significant investigation
Verdict: 📉 Under-estimated — root-cause analysis of the waypoint-sweep regression
was non-trivial.

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

### Feature (pre-existing commits on branch)

- `BTParallel` node (REQUIRE_ALL / REQUIRE_ONE / OBSERVE policies) added to
  `src/game/ai/behavior-tree.ts`; `BTCooldown` decorator; `frameCount` on
  `BTContext`; `parallel()` / `cooldown()` factory helpers.
- `BehaviorTreeAI` refactored to a `BTParallel(OBSERVE)` 2-track root:
  - **Track A**: unchanged priority selector (Retreat > Interact > Progress >
    LeaveSafeRoom > Engage > Collect > Hunt > Explore).
  - **Track B** (`buildOpportunisticLayer`): three side-effectful nodes that
    write pull/dodge vectors blended additively into Track A's output direction:
    - `OpportunisticCollect` — loot pull within player grab radius (120px)
    - `OpportunisticDodge` — perpendicular strafe on fast-closing enemies (96px)
    - `OpportunisticFarm` — drift toward nearest enemy during genuine wander
- `parallel-bt-lab` added and registered in `src/lab-main.ts`.
- Existing tests updated for `frameCount` on BTContext.

### Regression fix (this session)

After rebasing onto `origin/main` (which included the ranged-AI standoff PR
#250), the headless floor-1 gate failed: seed 2 timed out at 318s (level 12,
40 kills) instead of clearing at ~221s (level 6, 15 kills).

**Root cause**: `OpportunisticCollect`'s waypoint sweep scanned ALL A* path
waypoints for loot within 64px (`WAYPOINT_SWEEP_RADIUS_PX`). Since A* paths
cross most of the floor, and XP gems accumulate near enemy-killed areas, the
sweep created a systematic bias toward loot-dense (= enemy-dense) zones. This
caused the AI to fight 2–3× more enemies than necessary, blowing the 300s
budget.

**Investigation steps**:

1. Confirmed zero-weights pass (Track B tree has no effect) → vectors are the
   cause.
2. Isolated: `collectPullWeight=0` passes, `dodgeWeight=0` also passes with
   `collectPull=0.15` fails → collect pull is the culprit.
3. Removed waypoint sweep; player-proximity-only collect still fails at any
   non-zero weight → loot pulls systematically bias exploration regardless of
   check method.
4. Set `collectPullWeight: 0.0` → headless gate passes.

**Changes**:

- Removed the waypoint sweep from `OpportunisticCollect`; only the
  player-proximity grab radius (120 px) check remains.
- `collectPullWeight` default set to `0.0` — disables collect and farm pull
  vectors until additional headless seeds validate the budget is safe.
- Removed unused `WAYPOINT_SWEEP_RADIUS_PX` constant.
- Added suspension guards in `OpportunisticCollect` and `OpportunisticDodge`
  for `INTERACT` state and Progress-driven EXPLORE (`targetEid !== null`) as
  defensive hardening for when `collectPullWeight` is re-enabled.
- `dodgeWeight: 0.25` remains active and was confirmed safe on seed 2.

## What's Next

- **Re-enable collect/farm pull**: probe additional seeds
  (`npm run ai:headless -- --seed N --max-frames 19800`) until 3+ seeds are
  confirmed safe with `collectPullWeight > 0.0`. Then re-enable the default.
- **Tune waypoint sweep**: if a waypoint-sweep pull is desired in future,
  restrict it to waypoints within a smaller look-ahead window (e.g. next 5
  waypoints) rather than the entire path, to avoid map-scale loot bias.
- **OpportunisticFarm radius**: `GOLD_FARM_ENEMY_SCAN_RADIUS_PX = 1200` is
  very wide; consider reducing once collect is re-enabled so farm doesn't
  pull the AI out of quest navigation windows.

## Blockers

- None.

## Branch State

- Branch: `copilot/examine-behavior-tree-system`
- All tests passing: yes (`npm run verify` ✅, headless ✅)
- PR created: yes (this session)

## Test Results

- `npm run verify:fast` ✅
- `npm run verify` ✅
- `npm run test:headless` ✅ (seed 2 clears)

## Key Decisions Made

- Disabled `collectPullWeight` default (set to 0) rather than removing the
  infrastructure — the Track B framework is preserved for future tuning.
- Used `git merge origin/main` instead of rebase to keep the branch
  fast-forward-pushable from the remote tip.
