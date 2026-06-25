# ADR 0023: Line-of-sight melee hits and AI loot-reachability gating

## Status

Accepted

## Date

2026-06-27

## Estimated Complexity

🍎🍎🍎🍎 — touches 3 layers (`src/core` melee resolution, `src/game` weapon
targeting, `src/game/ai` goal selection). No new ECS system, so no new lab
obligation, but the change alters combat damage resolution and AI goal
selection — two systems with cross-cutting behavior — so an ADR is warranted.

## Context

Reported on seed 42 during the Floor 1 boss fight: the AI-driven player (1)
damaged enemies **through walls**, and (2) got stuck trying to collect loot
**outside the boss room**, stranded behind the still-locked boss door, wiggling
in place until a watchdog abandoned the goal.

Investigation confirmed FOV is healthy and not the cause. `fovSystem` runs every
simulation step (headless `simulation-step.ts`; visual `MainGameScene.ts`), and
the rot-js recursive shadowcaster is correct (the "should not see through walls"
test passes). The bug was four concrete gaps, none of them in FOV:

1. **Melee target selection bypassed line of sight.** ADR 0018 added an
   FOV-or-LOS gate to `getNearestEnemyTarget` and wired the **ranged** call site
   to respect it, but explicitly left **melee** on `ignoreFov = true` as a
   deferred follow-up, reasoning that "a wall between the player and a sub-2-tile
   enemy is not the reported failure mode." The boss fight is exactly that
   failure mode: the player hugs a wall with a boss/add one tile away on the far
   side.

2. **Melee damage resolution had no LOS check at all.** `meleeSwingSystem`
   (`src/core`) applied arc damage purely from blade geometry. Even with correct
   target selection, the swing arc still overlapped — and damaged — any entity on
   the far side of a thin wall, and symmetrically let enemy swings hit the player
   through walls.

3. **Boss-priority targeting had no LOS gate.** `findBossTargetInRange` (used by
   **both** melee and ranged paths) returned a permanently-aggroed boss whenever
   it was within gate range, with no sight check. Because `fireTarget =
bossTarget ?? target` overrides the legitimately-visible target, a boss behind
   a wall could be shot or swung at through the wall — a hole the ADR 0018 ranged
   fix did not close.

4. **AI loot goals ignored reachability.** `findNearestLoot` / `findNearestGold`
   selected by Euclidean distance + a blacklist only, unlike `findNearestEnemy` /
   `findNearestQuestEnemy`, which already return the nearest **reachable**
   candidate via door-aware A\* (`isEnemyReachable`). Loot dropped behind the
   locked boss door became a `COLLECT` goal; the AI parked on it and wiggled
   until the dwell watchdog dropped it ~180 frames (~3s) later — the "gets stuck
   for a bit."

## Decision

### 1. Gate melee damage on line of sight (`meleeSwingSystem`, core)

Add a null-guarded LOS check inside the per-target hit loop: skip a hit when
`world.floorMap` exists and `!world.floorMap.hasLineOfSight(px, py, tx, ty)`,
where `(px,py)` is the swing origin (owner position) and `(tx,ty)` the target.
This is the **airtight backstop**: regardless of how a swing was aimed or
spawned, no melee damage crosses a wall, in either direction (player→enemy and
enemy→player). When `floorMap` is `null` (most unit fixtures) the gate is a no-op,
preserving existing geometry-only melee tests.

`FloorMap` lives in `src/core/map`, so calling `hasLineOfSight` from a core
system introduces no layer-rule violation.

### 2. Respect LOS in weapon melee + boss targeting (`weaponSystem`, game)

- Change the melee fire path from `getNearestEnemyTarget(world, x, y, true)` to
  `false`, so melee target selection honors the same FOV-or-LOS gate ranged
  weapons already use (completing the ADR 0018 follow-up).
- Add the FOV-or-LOS gate inside `findBossTargetInRange`, mirroring
  `getNearestEnemyTarget`: a boss tile that is neither `isVisible` nor has a clear
  `hasLineOfSight` from the player is skipped. This closes the through-wall boss
  hole for **both** melee and ranged.

### 3. Gate AI loot goals on reachability (`bt-ai-provider`, game/ai)

- Rename `isEnemyReachable` → `isTargetReachable` (and `enemyReachableCache` →
  `targetReachableCache`). The method is position-based and already works for any
  target; the rename reflects that loot now uses it too. Reachability stays
  cached per-eid for `REACHABILITY_CACHE_TTL_FRAMES` (20) frames.
- Rewrite `findNearestLoot` and `findNearestGold` to collect candidates, sort by
  distance, and return the nearest **collectable** one, where collectable means
  `distance <= DIRECT_MOVE_EPSILON_PX` (already adjacent) **or**
  `isTargetReachable` via door-aware A\*. The sticky-target fast-path is gated the
  same way, so a goal that becomes unreachable mid-pursuit (the boss door
  shutting) is dropped instead of chased.

Because door-aware A\* (`buildDoorAwarePassable`) already treats a locked,
unsatisfied boss door as a wall, the gate **automatically** excludes loot behind
the locked door and **re-includes** it the moment the boss dies and the door
unlocks — no special-casing of doors in the loot finder.

## Consequences

### Positive

- No attack — melee arc, melee auto-aim, ranged, or boss-priority — ever crosses
  a wall. The melee-resolution gate is a geometry-independent backstop.
- The AI no longer commits to loot it cannot path to, eliminating the
  wiggle-then-abandon stall. It explores or fights instead, and returns for the
  loot once the door opens.
- The fix is deterministic end to end: integer tile LOS (Bresenham) and the
  existing deterministic A\*; no new RNG or wall-clock reads.

### Negative

- `meleeSwingSystem` now performs one tile-walk LOS check per candidate hit when
  a `floorMap` is present. Melee candidate counts are small and the walk is
  integer-only; cost is negligible.
- Loot reachability runs door-aware A\* (cached 20 frames) for loot candidates,
  the same machinery enemy finders already use. Bounded and cached.

### Risks

- Loot-reachability gating changes AI goal selection across seeds. Mitigation:
  the headless Floor 1 completion gate (weapon × seed sweep) must stay green; the
  change is neutral-to-positive because the AI stops wasting frames on
  unreachable loot. Verified via `npm run verify`.
- The melee LOS gate keys on the **owner** position as the swing origin. For
  swings whose owner has no `Position`, the system already falls back to the
  swing's stored position, and the gate simply uses that origin — consistent with
  prior behavior.

## Alternatives Considered

- **Only fix melee target selection (no resolution gate).** Selection alone is
  insufficient: a swing aimed at a valid in-front target can still arc into an
  enemy behind a thin wall, and enemy-owned swings would remain unguarded. The
  core resolution gate is the authoritative backstop.
- **Suppress the loot drop behind the locked door at spawn time.** That couples
  loot spawning to door state and would wrongly hide loot the player can legitimately
  reach later. Gating at goal-selection time, via the same reachability the door
  already governs, is local and self-correcting.
- **Lower the dwell watchdog timeout to abandon unreachable loot faster.** Treats
  the symptom; the AI would still briefly commit to and visibly wiggle toward
  loot it can never reach. Reachability gating prevents the commitment entirely.

## Related

- ADR 0018 — line-of-sight gate for weapon auto-targeting (ranged). This ADR
  completes its explicitly-deferred melee follow-up and closes the boss-targeting
  hole it left open.
- ADR 0021 — Floor 1 room reachability and the door-aware passability /
  `buildDoorAwarePassable` machinery the loot gate reuses.
- ADR 0020 — the in-AI quest-progress watchdog whose dwell timer previously
  masked the unreachable-loot stall.
