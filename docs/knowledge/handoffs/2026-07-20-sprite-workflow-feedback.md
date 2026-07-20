# Session Handoff: Sprite workflow calibration and feedback

## Date

2026-07-20

## Persona

Producer -> Tools/DevEx Engineer

## Systems touched

sprite-pipeline, sprite-workflow, devtools

## Apples

3 apples estimated, 3 apples actual.

## What Was Done

- Split art taxonomy into `equipment`, `item`, and `prop`, including defaults,
  schemas, plan metadata, selected brief metadata, and historical manifest types.
- Added canonical `mobRole` metadata. Boss briefs default to a large size hint,
  generation prompts require a large/tall/wide dominant silhouette, and the judge
  scores a conditional `boss_presence` axis.
- Changed the enemy default to a camera-facing three-quarter pose. Enemy and
  character judging now includes `pose_orientation`; explicit left/right hints
  remain directional biases and never request a full side profile. The one
  conflicting beetlefolk boss brief was migrated.
- Added a conditional `presentation` judge axis so equipment is an isolated
  wearable icon, items remain inanimate pickup icons, and props read as grounded
  world-space objects.
- Approval now preserves complete sensor breakdowns and judge scorecards in the
  generated manifest for future calibration analysis.
- Sprite Review now records per-criterion thumbs up/down and optional comments in
  `sprite-review-feedback.json`, separate from asset-level favorite/disliked
  annotations. Asset-level dislikes are injected into the pure reference selector
  and excluded from future generation references.
- Synchronized the Sprite Review and Workflow canvases with all current judge
  axes. The extension sidecar adapters retain legacy `styleMatch` compatibility.

## Validation and Observation

- The deterministic workflow coverage includes prompt contracts for normal mobs,
  bosses, characters, weapons, equipment, items, props, and tiles; dynamic judge
  axes; complete approval evidence; disliked-reference exclusion; feedback
  persistence; and both judge displays.
- Reloaded the real `project:sprite-review` canvas against the Azure-backed
  sidecar at `http://127.0.0.1:4490`. The canvas listed live Azure runs.
- Posted criterion feedback through the canvas-local `/api/feedback` route,
  observed the entry in the checked-in feedback store, then cleared it through the
  same route and observed its removal.
- The 3-apple review loop found and fixed dynamic-axis numbering, invalid JSON
  examples, legacy profile-facing prompt conflicts, and hidden Workflow-canvas
  axes.

## Key Decisions

- Criterion feedback rates machine results; it does not replace asset-level
  favorite/disliked annotations. Only asset-level `disliked` affects references.
- `mobRole` is authoritative for boss judging. Name inference remains only a
  default sizing hint for existing issue-driven briefs.
- Floor-contrast sensing remains deferred.

## Follow-up

- Use accumulated criterion feedback in a later calibration pass to measure which
  deterministic sensors and judge axes are more often wrong than right.
