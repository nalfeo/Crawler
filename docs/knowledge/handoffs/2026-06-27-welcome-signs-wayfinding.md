# Session Handoff: Door-pointing welcome signs in every room with baked WELCOME text

## Date

2026-06-27

## Persona(s) adopted

**Producer** (lead), orchestrating Content Designer (Floor 1 wayfinding/sign
placement in `floor1Scenario.ts`), UX/Graphics Designer (baked "WELCOME" sign
texture + render-time variant swap in `PhaserBridge.ts`), and QA Engineer
(regression suite in `tests/game/welcome-signs.test.ts`).

## Routing verdict

✅ Right persona — the change deliberately spans game-content placement,
engine rendering, and tests, so Producer coordinating the three layers was the
correct call.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — the delivered change is a Medium feature (3 files, new
placement sub-logic + two-variant baked rendering + regression tests, no new ECS
system/lab/ADR). The mid-session rebase onto a heavily-refactored `main` (see
below) was process recovery, not added feature complexity, so it does not change
the score.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Implemented Floor 1 "welcome" wayfinding signs end to end:

1. **Door-pointing, every-room placement** (`src/game/floor1Scenario.ts`)
   - Added `findNavigableRoomPathSteps()` + `NavigableRoomStep` — walks the real
     door-aware tile path from spawn to the welcome office and records, per room,
     the first DOOR tile crossed on the way out ("the door to take next").
   - Replaced the old sparse every-2–3-rooms logic
     (`getNextWelcomeSignRoomIndex` / `placeWelcomeSign`) with
     `placeWelcomeSigns()`: one sign in **every** room on the path (excluding the
     destination), each angled from the room centre toward its exit door.
   - **NPC avoidance**: placement runs **after** NPCs spawn; each sign resolves to
     a passable interior tile that is neither the player spawn tile nor an NPC
     tile, spiralling outward from the room centre when the centre is blocked.

2. **Baked, upright "WELCOME" rendering** (`src/engine/PhaserBridge.ts`)
   - Two canvas-baked 48×26 textures: `__cw_welcome_sign` (arrow right) and
     `__cw_welcome_sign_left` (arrow left), both with the word **WELCOME** baked
     into the board (not floating above it) via `drawSignArrow` + `bakeSignTexture`.
   - Render-time variant swap: when `Math.cos(angle) < 0` (arrow points more than
     halfway to the left) the renderer uses the left texture rotated by
     `angle − π`, so the arrow still points the right way while WELCOME stays
     upright. Facing is tracked on `EntityVisual.welcomeFacing` (mock images in
     unit tests have no `.texture` getter).

3. **Regression tests** (`tests/game/welcome-signs.test.ts`)
   - A sign in every path room (minus destination), each pointing at its exit
     door, never on the player spawn tile, and never on top of an NPC.

### Mid-session correction (important)

This branch was cut from a `main` that was **~11 commits stale**. Current `main`
had landed `feat(floor1): constant-combat spawn density + shared flow-field
pathfinding (#343)` and `feat: generic Spawner mob-type (#345)`, which heavily
refactored `floor1Scenario.ts`. On the stale base the **headless Floor 1 gate**
failed its wall-time perf guard (combos at 30–85s vs the ~6.7s the budget
expects) because the base still ran the **old, slow pathfinding**. Diagnosis was
confirmed by the tell-tale variance (near-identical frame counts, wildly
different wall times) and by the gate test being byte-identical to `main`. Fix:
committed the feature, **rebased onto `origin/main` (8cb53d6)** — applied cleanly
(my edits only touch the welcome-sign region; main's churn was in the
director/pathfinding region) — and the gate then passed all 68 combos in ~124s.

## What's Next

- PR #360 is open; arm auto-merge (`gh pr merge --auto --squash`) once a reviewer
  / the user authorizes per repo merge policy.
- Optional polish: signs whose exit door is **exactly** vertical (arrow N/S,
  `cos≈0`) render WELCOME sideways — inherent to a single rotating board. If
  desired, add up/down text variants; out of scope here (user only specified the
  left-hemisphere case).

## Blockers

None. All gates green on the up-to-date base.

## Branch State

- Branch: `nalfeo-welcome-signs-path` (rebased onto `origin/main`)
- All tests passing: yes (`npm run verify` ✅ — all 8 steps)
- PR created: yes — #360

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present this session — no telemetry section.

## Test Results

- `npm run verify` — ✅ Full verification passed (typecheck, lint, format,
  dead-code, unit+coverage, integration, headless Floor 1 gate 68/68, vite build).
- Headless gate standalone on the rebased base: 68 passed in ~124s (well under
  the 30s/combo perf budget).
- Targeted: `tests/game/welcome-signs.test.ts` + `tests/game/floor1-scenario.test.ts`
  — 41 passed.
- Visual: in-game lab screenshot shows a baked "WELCOME" sign in the spawn room,
  clear of the player and the NPC, arrow pointing toward the exit door; an
  8-direction renderer grid confirms WELCOME stays upright across both
  hemispheres (left variant auto-used past vertical).

## Key Decisions Made

- **Two baked textures + render-time swap** rather than a live Phaser Text
  object: keeps the word part of the sprite (rotates with the board), avoids
  depth/camera-culling bookkeeping, and works in the headless/mock paths.
- **Place signs after NPC spawn** so NPC tiles are known and can be avoided;
  spiral-out from room centre keeps a sign in every room even when the centre is
  occupied.
- **Angle measured from room centre → exit door** so the arrow reads as "go this
  way" even when the sign tile is nudged off-centre to dodge an NPC.
- **Rebase rather than patch around the stale base** so local validation matches
  what CI/`main` actually run.
