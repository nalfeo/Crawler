# Handoff: Merge Sprite Review into Workflow

## Date

2026-07-20

## Persona

Producer coordinating Tools/DevEx implementation and QA/reviewer validation.

## Systems touched

sprite-workflow, devtools

## Apples

Estimated: 3

Actual: 3

The tools-only cap held: the change consolidated two canvases, extended the
existing feedback/cache contracts, and added focused Workflow UX without a new
backend or game system.

## What changed

- Removed the standalone Sprite Review extension and made Sprite Generation
  Workflow the single surface for run inspection, judge/sensor evidence,
  criterion feedback, acceptance, and lifecycle status.
- Moved feedback persistence and request validation into shared extension
  modules while preserving atomic writes, locking, mutation-token/origin/content
  type checks, the 16 KiB request cap, and legacy criterion entries.
- Extended the feedback store as a discriminated union for criterion, whole
  sheet, and brief feedback. Draft thumbs/comments remain local until the
  per-item checkmark confirms them.
- Added cache-first run rendering with background Azure revalidation, selection
  ownership guards, resolved-run warm-key seeding, explicit-sheet cache bypass,
  and post-await stale-write protection.
- Added per-variant unaccepted, accepted/staged, integrated, and unverified
  lifecycle status. Accepted variants expose Re-accept through the same
  idempotent sidecar acceptance operation.
- Added text filtering beside the native run selector, a 512 by 512 default
  sheet preview with full-size toggle and overlay redraw, collapsed judge/sensor
  summaries, an accessible brief modal, and exact Post-process context handoff.
- Extended Postprocess Debugger open input to preserve brief, run, sheet, and
  variant selection.

## Runtime observation

Before this change, Sprite Review and Workflow were separate surfaces, Workflow
could block on repeated Azure reads, sheets consumed their full 1024 by 1024
layout area, and review feedback/status was split across canvases.

After reloading the real project extensions against the managed Azure sidecar:

- the standalone Sprite Review provider was absent and Workflow was ready;
- opening the warmed Runs surface painted in 89 ms with no blocking spinner;
- the 1024 by 1024 source sheet rendered at 512 by 512 by default;
- toggling 512 -> full -> 512 rendered 512 -> 1024 -> 512 while retaining all
  16 slice overlays;
- filtering `iron-cleaver` reduced 109 run options to the two matching runs;
- judge and sensor details were collapsed into independent summaries;
- sheet feedback comments were hidden until a thumb was selected;
- the brief modal loaded the exact run brief, retained focus after its async
  rerender, closed on Escape, and returned focus to View Brief;
- accepted iron-cleaver variants showed ACCEPTED/STAGED and Re-accept while
  unaccepted variants showed Accept & queue;
- the generated Post-process handoff contained
  `briefId=iron-cleaver-v1`, the exact run id, `sheet=sheet-00.png`, and
  `variantIndex=0`; opening Postprocess with those inputs preserved the run,
  sheet, and variant.

## Review harness

Ledger:
`docs/knowledge/review-ledgers/2026-07-20-merge-sprite-review-workflow.review-ledger.json`

- Separate-model plan review: 10 concerns resolved across the base and expanded
  UX plans; `plan_divergence: minor`.
- Code review round 1: four cache/state/provenance findings resolved.
- Code review round 2: four modal/revalidation/action-path findings resolved,
  including deterministic validation of the final post-await selection race.

## Validation

- Shared, Workflow, and Postprocess focused Node suites passed after the
  consolidation and review fixes.
- `node --test .github/extensions/workflow/tests/renderer.test.mjs` passed 26
  tests after the runtime-discovered modal focus fix.
- `npm run verify:fast` passed after every final review/runtime fix.
- Real Workflow and Postprocess canvases were observed through Chrome against
  the managed sidecar at `http://127.0.0.1:7690`.

## Key decisions

- The sidecar/shared resource cache remains authoritative; canvases do not add
  another persistent image cache.
- Integration status is exact per variant and requires both manifest selection
  and runtime reference evidence. Missing provenance is unverified, never
  guessed.
- Feedback confirmation patches only the touched local feedback state so it
  cannot recreate the loaded sheet or regress warm paint.
- Canvas iframes cannot invoke another canvas through a privileged host bridge.
  Workflow therefore emits and copies the repository's established
  `project:postprocess ...` deep-link form with complete context.

## Blockers

None.
