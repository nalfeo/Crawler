# Floor 3 slice 14 UX completion

## Systems touched

hud-ux, minimap, quests, main-scene-probe-lab, floor3-companion-league

## Scope and authorization

Issue #3539. Verdict: recommended; estimate 3 apples, actual 3 apples.
UX Designer persona. The supplied producer artifact names a missing plan file,
but includes the complete acceptance gate; the hydrated issue supplies requirements.
The user authorizes implementation, focused checks, and a local commit only.
Do not push, open a PR, modify the issue, or merge; deterministic runner stages
own those mutations. These limits transfer with this handoff.

## Completed plan

1. Trace shipped versus, endgame, keep-one, party controls, markers, and quests.
2. Fix remaining marker allegiance and duplicate Studio HUD behavior.
3. Extend deterministic real-scene coverage, run focused and required local
   checks, review the complete diff, and commit locally.

## Changes and observation

The baseline three real MainGameScene tests passed and positively asserted the
old purple Studios counter. Player Companions retain the Enemy ECS component;
minimap styling previously painted them red. Both map surfaces now resolve
Companion plus player Team before enemy styling and render allies green
(#4ade80). Neutral NPC dots are lavender (#e2b6ff), and cleared Floor 3 markers
are slate (#94a3b8), reserving the ally color for the player's Companions.

The standalone panel is hidden during Studio progression. Existing canonical
Studio quests supply the standard tracker; the Final Four bracket and endgame
panel remain. No simulation rules or progression state ownership changed.
Command controls were already removed by the automatic-party design; Roster
remains usable without overlapping the companion panel.

The updated fixed-seed MainGameScene test observes a visible standard Studio
quest, no standalone panel, green ally draw colors in both map surfaces, and
an actual green pixel in the radar. For the pixel check only, the paused lab
places a recruited ally two tiles from the player inside the discovered spawn
room so the player's glyph cannot cover it. Studio defeat is driven by knocking
out the active roster in the lab; production objective and quest ticks then
clear the marker, increment the canonical count, and remove the completed
quest and waypoint. This fixture verifies presentation wiring, not combat balance.
The real headless completion test separately observes production combat.
Screenshot: files/floor3-ux-after.png (local runner artifact).

## Validation

- Preflight passed.
- Baseline real-scene tests: 3 passed.
- Party controls: 1280x720, 960x540, 1920x1080 passed, including keyboard,
  touch, pause/resume, and no panel overlap.
- Updated league tracker/marker/pixel and quest-waypoint browser checks passed.
- Real-scene AI runner modal autonomy passed: versus rounds, victory,
  required keep-one selection, and continued runtime flow.
- Focused view-model and wiring tests: 39 passed; victory-system tests: 24 passed.
- Headless completion and poach/loadout suites: 6 passed.
- Typecheck and verify:fast passed; scope reports gameplay_safe=true,
  visual_touched=true. Final validation is recorded in local files/floor3-\*.log.
- Read-only review-agent review: no findings, okay to check in.
- No files/guard-telemetry.jsonl existed to capture.
- Handoff lint reports three pre-existing missing retrospective subsections in
  2026-09-26-merge-train-synchronize-reevaluation.md; no findings in this handoff.

## Risks and remaining work

Palette changes are intentional, reversible rendering changes. Accessibility
beyond these colors and viewport checks is not claimed. Existing production
loss/keep-one rules remain covered by the Floor 3 victory-system tests.
The deterministic runner owns subsequent review, publication, and issue updates.

## Retrospective

### Lessons Learned

Companions retain Enemy for shared combat queries, so minimap allegiance must
check both Companion and Team. Draw telemetry alone does not prove a visible
pixel when the player glyph can cover an ally at the same position.

### Mistakes Made

The initial test probe checked only the Team store and classified neutral NPCs
as allies. Requiring the actual ECS components corrected the probe; no gameplay
state or acceptance threshold was relaxed.

### Opportunities for Future Improvement

A future accessibility pass can evaluate marker shapes as well as colors.
