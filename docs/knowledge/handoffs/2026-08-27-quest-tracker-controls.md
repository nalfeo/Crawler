# Session Handoff: Quest tracker controls

## Date

2026-08-27

## Persona

UX Designer

## Systems touched

hud-ux, quests

## Apples

3🍎 estimated, 3🍎 actual

## What Was Done

Placed the quest tracker below the docked minimap on every floor. The Floor 2
family panel now receives the quest tracker as an existing avoidance region and
relocates when necessary. Added an `↑ ON` / `↑ OFF` control for each surfaced
active quest. The control toggles that quest's independent navigation state,
removing or restoring only its directional arrow and minimap waypoint markers;
the existing single focused/expanded `tracked` state is unchanged.

## Validation

- Before: the deterministic MainGameScene probe's Floor 2 layout placed the
  quest tracker at the upper-left; there was no per-quest arrow control.
- After: `tests/e2e/quest-waypoint-arrows.deterministic.test.ts` boots the real
  MainGameScene, confirms the tracker is beneath the minimap, clicks the
  shop-quest control, observes only its arrows disappear, then clicks again to
  observe them return.
- Added `tests/e2e/main-game-scene-family-hud-map.test.ts` → "MainGameScene
  Floor 2 family panel vs quest tracker layout": boots the real Floor 2 scene
  (which auto-accepts `FLOOR2_FIND_SETTLEMENT_QUEST_ID` on floor init, so the
  tracker is guaranteed live), activates the family panel, and asserts
  `familyPanel`/`questTracker` `getSafeAreaLayout()` bounds never overlap at
  1280x720 and 960x540 — the family panel's runtime avoidance logic
  (`getAvoidBounds` in `HudUI.ts`) is now covered with a visible tracker,
  closing the gap the static layout-only assertions left.
- Fixed a toggle-position bug in `HudQuestTracker.ts`: toggle rows were
  positioned/keyed off the raw (pre-wrap) line index, so a wrapped or
  truncated objective line could desync a later quest's toggle from its
  rendered row, and a truncated-out quest's toggle stayed visible/interactive.
  `fitQuestTrackerLinesWithRowMap` now maps each quest's title row through the
  same wrap/truncate pass that produces the rendered body, and quests whose
  title row is truncated away get no toggle at all. An independent re-grade
  after this fix caught a follow-on regression in the same area: `sync()`'s
  final loop unconditionally re-showed every cached toggle (including ones
  just hidden because their row was truncated away), silently overriding the
  per-quest truncation check. Fixed by tracking truncated quest ids for that
  frame and excluding them from the unconditional re-show pass.
- Routed the toggle click through the sim's own input pipeline instead of
  HudUI retaining a `GameWorld` reference and calling `toggleQuestArrow`
  directly from a HUD callback (`.github/instructions/engine.instructions.md`
  forbids HUD widgets writing back into sim state). `HudQuestTracker`'s click
  now only queues the request; `HudUI.consumeQuestArrowToggleRequests()`
  drains it, and `MainGameScene.update()` — which already applies other
  input-driven core-system calls (`equipFromBag`, `selectLoadoutOption`) —
  applies `toggleQuestArrow` before the next `hudUi.sync()`.
- Visual-review evidence (Rule 9): Azure Vision credentials for
  `review:visual:llm` are not available in this sandbox, so validation stayed
  deterministic per Rule 9's preference (never LLM-as-judge). Screenshots
  captured via the same real MainGameScene probe used above, gated behind
  `QUEST_TRACKER_EVIDENCE_DIR` (no-op in CI):
  `files/visual-review/quest-tracker-controls/tracker-below-minimap-both-arrows-on.png`
  and `.../shop-quest-arrow-toggled-off.png` (both `files/` artifacts, not
  committed). Confirmed by inspection: the tracker sits fully clear of the
  minimap radar, both `↑ ON` toggles are legible against the panel, and after
  clicking the shop quest's toggle its row reads `↑ OFF` while its field arrow
  and minimap waypoint vanish and the other quest's arrow is unaffected.
- `npm run verify:fast` passed.

## Key Decisions Made

`showArrow` is optional for backward compatibility with saved/test quest state:
only `false` disables navigation, while newly accepted quests explicitly begin
enabled. Waypoint output is limited to the same surfaced active-quest cap as
the tracker, so every displayed navigation arrow has a visible control.

## What's Next / Blockers

No implementation blockers remain.
