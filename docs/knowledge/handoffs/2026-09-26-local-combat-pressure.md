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

## Authorizations and Constraints

- Continue the combat-pressure task in
  `C:/Users/nalfe/.codex/worktrees/d952/Crawler`, branch
  `codex/local-combat-pressure`. The original continuation from task
  `01a0dfbd-6805-7e00-8c3e-092379d6d20f` explicitly requested a ready-for-review
  PR and stated: "User authorized continuations and all publication."
  The verified repository remote is `https://github.com/nalfeo/Crawler.git`.
- The user explicitly approved reconstruction in this session: "Yes, reconstruct."
- The user explicitly authorized LLM review of generated changes without
  repeated permission and requested the corresponding instruction correction.
  Review uses the configured Codex LLM review service with the relevant diff/context.
- The user explicitly requested that handoffs carry the same authorizations to
  subsequent sessions without requiring repeated approval. Carry this section
  forward verbatim or with accurate updates for later user instructions.
- Preserve the original diagnostic-only scope: no gameplay tuning, enjoyment
  calibration, human-data collection, or power/crafting/choice implementation.
  No user-requested local-only publication hold was recorded.
- Execution blocker, separate from user grants: automatic approval review
  rejected a previous GitHub push for insufficient destination-specific
  authorization evidence. The user subsequently made authorization inheritance
  explicit. Do not silently erase inherited publication authority in a continuation.

## Authorization continuity follow-up

Updated AGENTS, memory policy, and the handoff template. The continuation CLI
now requires `--authorizations` and emits the supplied grants, provenance,
destinations, limits and holds under Authorizations and Constraints, with an
explicit instruction against reauthorization solely due to session transition.
Focused generator tests and the canonical session-instruction check pass.

Authorization continuity passed required verify:fast and Ducky review with no
actionable findings. A real continuation CLI smoke preserved both the test grant
and its publication hold. GitHub read-only verification confirmed the configured
`nalfeo/Crawler` destination is public and the authenticated account has ADMIN
permission; this supplements the inherited publication authorization record.
