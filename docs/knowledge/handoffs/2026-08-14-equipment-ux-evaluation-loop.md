# Equipment UX evaluation loop

## Status

Implemented the equipment UI redesign, the screenshot-evaluation workflow, and
the Before/After review tooling.

## Systems touched

engine, tooling

## Changes

- Added arbitrary PNG/JPEG/WebP screenshot review with evidence-first JSON,
  explicit `not_observable` behavior limits, coverage, score, hard failures,
  and player-cost findings.
- Updated the Azure vision adapter to preserve arbitrary screenshot MIME types.
- Extended the screenshot viewer with Before/After pairing from
  `files/visual-review/before/` and `after/`, plus task-specific/reusable
  feedback persisted in `files/visual-review/feedback/before-after-feedback.jsonl`.
- Updated UX Designer and visual-review instructions with canonical artifact
  paths and feedback-promotion rules.
- Reworked the Phaser equipment panel into a stable paper-doll, stats, bag, and
  inspector layout with target-slot markers and visible comparison deltas.
- Exposed live equipment geometry and interaction seams from `ui-probe-lab`.
- Added deterministic real-Phaser coverage for pointer-driven equipped and
  unequipped-item tooltips, slot filtering, preview targets, equip, unequip,
  scroll, text containment, and readable glyph size.

## Verification

- `npx vitest run tests/e2e/inventory-flow.test.ts` passes (42 tests), including
  preview persistence through a filter-driven panel re-render.
- Screenshot viewer and arbitrary evaluator tests pass.
- `npm run verify:fast` passes.
- The Before render was captured from `main` at `8d53c5323` through the real
  Phaser `ui-probe-lab`; the After render was captured through the same lab on
  this branch. They have distinct SHA-256 hashes.
- Azure-backed advisory review recorded Before: 83/100, one hard failure
  (`MOVE M SLOT FOR DETAILS`); After: 84/100, zero hard failures. The review
  results explicitly retain still-image interaction limitations, while the e2e
  interaction tests are the behavioral evidence.
- The 5-apple review ledger is complete: the final independent grade found no
  findings and scored all five criteria at 5/5.
