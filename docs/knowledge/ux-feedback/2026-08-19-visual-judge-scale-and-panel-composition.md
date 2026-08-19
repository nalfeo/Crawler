# Visual judge: 0-100 scale + panel-composition rules

**Status:** accepted (applied to the judge, not merely proposed)
**Target:** `scripts/agent/review/visual-review-agent.ts`, `scripts/agent/review/visual-review-lib.mjs`,
`.github/extensions/screenshot-viewer/extension.mjs`

## 1. Score granularity (0-100)

The LLM visual judge previously scored 1-5. At that resolution a real fix — moving a
slot 10px, aligning a heading — could not move the number, so consecutive review
rounds all reported the same score and the A/B evidence looked static.

Applied:

- The prompt now asks for 0-100 on `overall.score` and every axis, with an explicit
  calibration band table and an instruction not to round to multiples of 10.
- `--min-score` accepts 0..100; the default pass gate moved from `4` to `80`.
- `normalizeOverallScore` clamps to 0..100 and **rescales a legacy 1-5 answer by 20**
  when both the overall score and every axis are `<= 5`, so a model that ignores the
  instruction does not register as a near-zero score.
- The Screenshot Viewer accepts raw reviews in 0..100 and infers the display scale
  from axis scores, so the committed 1-5 baseline evidence still renders correctly.

## 2. Panel-composition rules (from manual session feedback)

These defects were reported by hand across several rounds of the equipment UX work
and were consistently _missed_ by the judge. They are now explicit prompt rules and
must be emitted as `precise_fixes` with pixel deltas:

| Rule                          | Reported as                                                        |
| ----------------------------- | ------------------------------------------------------------------ |
| Heading placement consistency | "Stats and Bag should be the same level and style as Equipment"    |
| Paired-slot alignment         | "the ring slots are not aligned vertically with the other slots"   |
| Container overrun             | "top equipment slots ... overlap or run into the top bounding box" |
| Excessive padding / over-wide | "too much padding in the paperdoll"; "width can reduce"            |
| Centering                     | "vertically center the paperdoll within the equipment pane"        |

## Follow-up

Paired-slot alignment and container overrun are geometric and should be promoted from
prompt guidance into deterministic checks in the `window.__visualReview` region
evaluator, so they stop depending on model consistency.
