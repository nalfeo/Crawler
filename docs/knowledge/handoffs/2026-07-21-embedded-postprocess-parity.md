# Handoff: Embedded Postprocess parity

## Date

2026-07-21

## Persona

Tools/DevEx implementation with Producer coordination, browser QA, and separate-model review.

## Systems touched

sprite-workflow, sprite-pipeline, devtools, ci-policy

## Apples

Estimated: 3

Actual: 3

## What changed

- Restored both the source-sheet canvas and canonical slicing overlay in the
  embedded Postprocess Debugger, including the warmed-image ordering path.
- Preserved each pipeline image's natural aspect ratio inside a bounded preview
  instead of forcing square thumbnails.
- Added per-step Skip step / Run step controls backed by canonical,
  run-global `PostprocessOptions.disabledModules`.
- Kept disabled modules visible as pass-through trace rows and carried the
  disabled set through live preview, Apply, persisted summaries, cache
  invalidation, and fresh-instance hydration.
- Rejected unknown module IDs at the Workflow mutation boundary and module IDs
  outside the selected brief's effective pipeline at the sidecar boundary.
- Moved background tolerances into Background removal and facing, anchor, and
  Apply controls into Final output.
- Added Set anchor to middle using
  `(floor(naturalWidth / 2), floor(naturalHeight / 2))`.
- Documented and machine-checked the permanent three-apple ceremony cap for
  tooling-only changes.

## Runtime observation

Before the fix, the real embedded editor rendered both 640x640 source/slicer
canvases with `display:none`, pipeline previews were forced into square boxes,
skip controls were absent, and tuning/authoring controls were detached from the
steps they affected. Evidence:

- `files/postprocess-before.png`
- `files/postprocess-before.json`

After reloading the real project extensions and opening
`iron-cleaver-v1 / 2026-07-18T03-40-12-d4269ad7 / variant 0` through Workflow:

- both source and slicer canvases rendered at nonzero 642x642 bounds;
- every non-square pipeline preview preserved its natural ratio within 0.004;
- Color tolerance was inside Background removal;
- Facing, Set anchor to middle, and Apply changes were inside Final output;
- skipping Background removal changed its control to Run step and persisted
  through Apply plus a full Workflow page reload and exact-context reopen;
- Set anchor to middle wrote `(32,32)` for the 64x64 final image and placed the
  marker at the center pixel;
- the temporary skip and anchor used for the persistence proof were then cleared
  and re-applied so the run was left in its original state.

After-state evidence:

- `files/postprocess-after.png`
- `files/postprocess-after.json`
- `files/postprocess-after-snapshot.txt`

## Review harness

Ledger:
`docs/knowledge/review-ledgers/2026-07-21-embedded-postprocess-parity.review-ledger.json`

- Plan review: seven concerns resolved; `plan_divergence: minor`.
- Code review round 1: moved the center-anchor regression test out of an
  accidental parent-test nesting.
- Code review round 2: clean across correctness, lifecycle/order, contracts,
  security, runtime wiring, performance, and regression coverage.

## Validation

- Postprocess renderer and anchor tests passed (23 tests).
- Extension suites passed (136 tests).
- Sprite pipeline suites passed (113 tests).
- `npm run verify:fast` passed after the final review fix (313 changed tests).
- `npm run review:visual:deterministic` passed (20 tests).
- Declared visual-review geometry reported four regions and zero deterministic
  blockers.
- The LLM visual critique could not run because this shell has no
  `AZURE_OPENAI_ENDPOINT`; the deterministic and real-browser evidence above
  remains complete.

## Blockers

None for the deterministic/runtime acceptance gate. An Azure-authenticated shell
is still required to produce the optional dev-session LLM visual critique.
