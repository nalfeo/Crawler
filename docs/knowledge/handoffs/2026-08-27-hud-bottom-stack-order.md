# Session Handoff: Bottom-center HUD stack — ability bar at the canvas bottom, Talk hint above it

## Date

2026-08-27

## Persona

UX Designer

## Systems touched

hud-ux, mobile-ux

## Apples

2🍎 exact

## What Was Done

Issue #3679 reported the inverted bottom-center stack: the ability bar floated above a
Talk button that was pinned to the very bottom edge.

- `src/engine/HudAbilityBar.ts` — replaced the magic `BAR_Y = GAME.HEIGHT - 140` slot
  offset with a bottom-anchored derivation: `ABILITY_BAR_PANEL_TOP = GAME.HEIGHT -
ABILITY_BAR_PANEL_BOTTOM_MARGIN - ABILITY_BAR_PANEL_HEIGHT`, with the slot row derived
  from the panel top. Added an `isVisible()` read-back.
- `src/engine/HudUI.ts` — added `getAbilityBarScreenTop()`, which projects the authored
  panel top through the live `bottomCenter` scale and safe-area inset using the exact
  same math as `applyScale()`, returning `null` when the bar is not rendered.
- `src/engine/scenes/MainGameScene.ts` — `interactionHintY()` now returns
  `min(bottomBaseline, abilityBarTop - INTERACTION_HINT_ABILITY_BAR_GAP)`, and the hint's
  Y is refreshed each frame right after `hudUi.sync()` so it restacks when spells unlock
  or the HUD is hidden behind a modal.

**Observed in the real MainGameScene** (probe lab boot, 1280×720, spells unlocked, NPC
interaction primed — not a lab-only rendering of the widget):

- Before: `bottomCenter` = y 550, h 96 (bottom 646); `interactionHint` bottom 708 — the
  Talk button sat _below_ the bar, hard against the canvas edge.
- After: `bottomCenter` = y 612, h 96 (bottom 708, i.e. the authored 12px bottom margin);
  `interactionHint` = y 534.5, h 67.5 (bottom 602) — a clean 10px gutter above the bar.

The new e2e (`tests/e2e/hud-bottom-stack-order.test.ts`) was verified to **fail** on the
pre-fix source (`expected 646 to be greater than 708`) and pass after, so it is a real
regression guard rather than a tautology.

## Key Decisions Made

- **Deterministic constant projection, not `Container.getBounds()`.** Phaser container
  bounds are a live union over children and do not filter by visibility, so using them to
  position the hint would make the layout depend on transient child state. `HudUI` mirrors
  the `applyScale()` math instead.
- **The hint stays a scene-level object.** Folding it into the scaled `bottomCenter` HUD
  group would have changed its hit area, depth, and modal-hiding lifetime for no layout
  benefit.
- **Per-frame restack.** Ability-bar visibility is runtime state (spell unlock, HUD hidden
  behind a panel), so the existing ui-scale/safe-area change hooks alone were not enough.
- **Safe-area handling unchanged.** The parent group already offsets the bottom inset, so
  the new panel margin is purely the authored visual gutter and the landscape safe-area
  e2e still passes untouched.

## What's Next / Blockers

None blocking. A natural follow-up: the bottom-center stack now has three independent
owners of "how far up from the bottom edge am I" (`HudAbilityBar`, `MainGameScene`'s hint,
and the dialogue box). If a fourth affordance lands there, promote the stack into a pure
layout module in the style of `HudVitalsLayout.ts` rather than adding another `min()`.

## Retrospective

### Lessons Learned

- `getAbilityBarBounds()` on `HudUI` returns _authored design constants_, not the
  transformed group position — the probe lab already documents this in a comment, and it
  is exactly the trap that made a new `getAbilityBarScreenTop()` necessary. Anything that
  needs the on-screen position of a HUD widget must go through the group transform.
- `main-scene-probe-lab`'s `getSafeAreaLayout()` is a cheap, precise way to assert HUD
  stacking order in the _real_ scene: it already exposes both `bottomCenter` and
  `interactionHint`, so no new probe surface was needed.
- `git stash push <files>` → rerun the new e2e → `git stash pop` is a fast, reliable way
  to prove a new guard actually fails pre-fix without hand-editing constants back.

### Mistakes Made

- Published the plan with every checklist item already ticked instead of an all-unchecked
  starting state, which made the first progress report read as if the work were finished.
  Early signal: if the very first `report_progress` has no `- [ ]` entries, the checklist
  is wrong.
- Initially considered testing the new geometry only through the HUD lab. That would have
  been lab-only validation (rule #9) and could not have proven the _scene's_ Talk hint
  moved; switching to the main-scene probe lab was the correct call.

### Opportunities for Future Improvement

- The `hud-overlap-visual` e2e encodes ability-bar design Y values in a comment and a
  pixel band, so any bar re-anchor silently requires a matching test edit. Deriving that
  band from the exported `ABILITY_BAR_PANEL_TOP` / `ABILITY_BAR_PANEL_HEIGHT` constants
  would make the guard self-updating.
- That same test's comment claimed `ABILITY_BAR_MAX_SCALE = 1.2` while the constant had
  since become `1.0` — stale-by-comment drift that a constant-derived band would remove.
