# Local combat-pressure evidence

## Date

2026-09-26

## Persona

QA Engineer, with independent correctness review.

## Systems touched

ai-combat-balance, ai-behavior-tree

## Outcome

Additive v1 local-pressure evidence on RunStats and available live session-recorder
stats, surfaced separately in v2 per-run diagnostics. Local hostile mobs are
filtered by range, LOS, aggro, faction targeting and boss activation. Valid
outside-safe-space intervals distinguish threatened time, net-health-loss bursts,
recovery opportunities and post-combat downtime. Missing, malformed and flattened
multi-leg evidence stays unmeasured. No gameplay tuning, enjoyment calibration,
UX routing, score or independent win-gate changes.

## Files touched

- Shared combat-pressure types; game AI collector and world observation adapter.
- Headless runner, session recorder and human run-stat export wiring.
- Fun-score per-run diagnostic validator and focused runtime/report tests.
- Playtest evaluation framework: explicit spatial/temporal hypotheses and limits.

## Verification

- Reconstructed after the original isolated worktree disappeared; recovery patch
  saved outside the worktree before review. Fresh preflight passed.
- Focused diagnostics and evaluator tests: 83 passed. Real production headless
  output test passed before reconstruction and rerun on restored code.
- Actual production smoke: seed42, sword, 3600 frames, timeout at configured cap;
  57150ms observed, 2849.9999999998854ms safe, 0 invalid, 26966.66666666568ms
  threatened, 30183.33333333143ms unthreatened, peak3 local threats, net loss45,
  peak one-second net loss15, four recovery and four downtime windows.
- Independent read-only review found no medium/blocking issues after rejecting
  final-floor evidence on flattened multi-leg records.
- Required Ducky review found no actionable regressions; its 88 focused tests
  passed. The implementation session separately completed preflight. Ducky review
  passed and the change is okay to check in.
- PR prerequisites passed, including full lint. Required verify:fast passed:
  full typecheck, 114 affected test files / 1785 tests, and data-contract/integrity/coverage guards.
- Path checks passed. Repository-wide handoff lint reports three pre-existing
  missing retrospective subsections in 2026-09-26-merge-train-synchronize-reevaluation.md;
  this session handoff has all required subsections.

## Limitations and next steps

Net health loss is not exact damage-event accounting; simultaneous healing can
hide damage. Spatial evidence excludes projectiles, hazards and indirect paths,
and does not model stun or cooldowns. The 12/32ft neighborhood, 250ms sample gap,
1s burst and 2s/3s recovery/downtime thresholds are hypotheses. Live evidence
requires a recorder. Publish the ready PR after main synchronization and release to CI Recovery. No human-data collection or balance claim.

## Retrospective

### Lessons Learned

A final-floor object spread can make partial evidence look chain-wide; report
validation must explicitly reject that case until a genuine aggregation exists.

### Mistakes Made

The first implementation was left only in an isolated worktree that disappeared.
The reconstruction now has a recovery patch stored outside that checkout.

### Opportunities for Future Improvement

Future projectile/hazard observations and damage-event accounting could refine
these diagnostics, with new evidence versions and deterministic boundary tests.

## Maintainer instruction correction

Ducky invokes an LLM review service; calling it local was misleading. Updated
AGENTS, the review skill/reference, review policy, persona index and merge-train
guide to describe that accurately. Standing maintainer authorization covers
reviewing agent-generated changes and the relevant context through the configured
LLM review service without a separate review/transmission permission prompt.
Updated the existing policy contract assertions; both policy tests pass.

The instruction correction passed required verify:fast and Ducky review with no
actionable findings. The policy tests preserve the explicit authorization rule.
