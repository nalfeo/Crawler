# ADR: Safe rooms stop the floor timer; cleared boss arenas do not

## Status

Accepted

## Date

2026-08-27

## Estimated Complexity

🍎 x 3 — one new `src/core/` module plus a new world field and behavior flag,
wired through three floor scenarios, the HUD countdown and the AI's collapse
planning. No new lab, no rebalancing.

## Context

Issue #3674 (dev-build run `336473dc-5d18-47e5-a0e6-34512fda6e07`) reported two
halves of the same defect:

1. **A boss room turned safe room stopped the floor timer.** When a Floor 1 boss
   dies, `markBossRoomCleared` registers its arena in `world.clearedSafeRoomIds`
   and `isPointInSafeSpace` reports it as safe — the design's "Boss → Commercial
   Break" beat. Floor 1's collapse deadline was paused by that same predicate
   (`if (world.playerInSafeRoom) objective.deadlineMs += GAME.DELTA_MS`), so
   standing in a cleared arena froze the countdown for the rest of the floor. The
   arena is meant to be a breather, not an unlimited parking spot.
2. **After Floor 1 the entrance room stopped nothing.** Floors 2 and 3 declare
   `behavior.spawnRoomIsSafe: true`, so their entrance rooms already grant every
   other safe-room affordance, but their collapse checks compared **raw**
   `world.elapsedMs` against `manifest.timer.durationMs`. The countdown therefore
   kept running inside a room the design calls safe, and the HUD, the scenario
   and the AI's collapse planning all read that same uncredited wall.

"Safe" was doing two jobs at once: _nothing can hurt you here / you may
customize_ and _the show's clock is stopped_. The first correctly includes a
cleared boss arena; the second must not.

## Decision

- **DEC-001**: Split the predicate. `isPointInTimeStoppingSafeSpace`
  (`src/core/safe-space.ts`) covers only the safe spaces authored on the map —
  `RoomRole.SAFE` rooms and the entrance room on a `spawnRoomIsSafe` floor. A
  room that became safe _during_ the run (`world.clearedSafeRoomIds`) is
  deliberately excluded. `isPointInSafeSpace` keeps its existing meaning, so
  customization panels, weapon immunity, spawn suppression and every AI
  safe-room branch are unchanged.
- **DEC-002**: Bank the pause as credit, not as a per-floor deadline mutation.
  `safeRoomSystem` maintains `world.playerInTimeStoppingSafeRoom` and adds one
  tick to `world.safeRoomTimerCreditMs` while the pause is active. It already
  runs in `simulation-core-step`, so the real game and the headless runner get
  the same credit from the same code.
- **DEC-003**: One deadline resolver. `src/core/floor-timer.ts` exposes
  `resolveFloorTimerDeadlineMs` / `hasFloorTimerExpired`
  (`manifest.timer.durationMs + credit`) and `isFloorTimerPaused`. The floor
  scenarios (Floors 2 and 3), the HUD countdown (`floor-timer-state.ts`), the
  AI's collapse planning (`collapse-deadline.ts`) and the Floor 2 hunt-urgency
  window all resolve through it, so no consumer can disagree about when the
  floor ends. Floor 1 keeps its mutable `objective.deadlineMs` — it is read by
  save state, run summaries and the AI planning clamp — but extends it under the
  shared `isFloorTimerPaused` predicate, so the two timer shapes cannot drift.
- **DEC-004**: Floors opt in via `behavior.safeRoomPausesFloorTimer` (Floors 1–3
  `true`, Floor 4 `false`). Floor 4's timer is a deliberate raw wall-clock stall
  backstop sized to cover untimed Green Room visits; a backstop that can be
  paused indefinitely by standing still is not a backstop, so it banks no credit
  and its tick still compares raw `elapsedMs`.
- **DEC-005**: `RunStats.safeRoomMs` counts time-stopping frames only. The
  headless runner derives active time as `elapsedMs - safeRoomMs`, so a room
  that no longer pauses the deadline must no longer discount active time either
  — otherwise a cleared arena would buy unearned budget in the win-rate gates.
  Floor 4's `COUNTDOWN` phase stays an explicit additional exception (FR8.5), and
  human runs now report the same measure (`world.safeRoomTimerCreditMs`) instead
  of a flat `0`.

## Consequences

- Parking in a cleared boss arena now costs floor time — intended: the arena
  remains safe to shop/equip in, but the show clock keeps running.
- Floors 2 and 3 gain a real time-stopping entrance room; their effective floor
  length grows by whatever the player spends inside it, which is the same
  affordance Floor 1's safe room has always had.
- `safeRoomTimerCreditMs` is per-floor. Every canonical floor transition builds a
  fresh world (visual restart calls `createGameWorld`, headless progression runs
  one world per leg), so the credit starts at 0 without an explicit reset hook.
- Systems that legitimately want raw wall-clock time (door-lock timer
  conditions, cooldowns, spawners, the Floor 4 arena timeline) keep reading
  `world.elapsedMs`; the credit is scoped to floor-collapse consumers only.

## Alternatives Considered

- **Rewrite the cleared arena's `RoomRole`** so it stops being "safe" for timer
  purposes: rejected. `FloorMap.bossStairRoom` and the stair/spawn/minimap
  consumers resolve that room _by role_, so the boss room would vanish from
  under its own staircase.
- **Give every manifest floor a Floor-1-style mutable deadline**: rejected. It
  duplicates mutable state per floor and gives the HUD and AI another chance to
  read a stale copy; the credit field is a single value all consumers add.
- **A universal "effective elapsed time" clock**: rejected. It would silently
  pause door-lock conditions, cooldowns, spawners, quests and the Floor 4
  backstop, far beyond the reported defect.
