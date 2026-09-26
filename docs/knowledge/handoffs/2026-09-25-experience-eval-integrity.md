# Experience evaluator evidence integrity

## Date

2026-09-25

## Persona

Producer coordination; DevOps for evaluator/report consumers; Game AI Engineer
for telemetry; independent Reviewer for design and complete-diff review.

## Systems touched

ai-combat-balance, ai-behavior-tree, ci-policy

## Outcome

Implemented the improvements that do not require real player session data.
Version 2 separates uncalibrated heuristics from direct human surveys and makes
missing observations explicit. No gameplay tuning or Floor-1 win-rate contract
changed. Release reports remain diagnostic only.

- Starting-weapon coverage no longer affects the score or gate. Choice depth,
  build distinctness, and enjoyment confidence are unmeasured.
- Output/acquired-progression heuristics saturate instead of penalizing high
  output. Progression excludes initial XP and starting levels, and counts earned
  levels independently of how many XP pickups delivered them.
- Human placeholders and interrupted observations have explicit coverage flags.
  Bot health fractions follow changing maximum HP instead of a stale baseline.
- Reports retain per-run identities/diagnostics and survey item counts. Trends
  require compatible versions and matching independent scenario identities,
  including release-leg distinctions. Human comparisons require a future
  participant-aware study design.
- Historical reports remain visible; nullable reports retain artifact links.
- Both the extension viewer and public release page enforce the v2 boundary.
  Release sweeps explicitly attribute their production preset. Flattened chains
  mark final-floor-only observations unavailable for whole-chain scoring.
- Corrected a pre-existing test-helper DamageOrigin literal from weapon to
  player so required TypeScript validation can run without relaxing its type.

## Validation

- Focused evaluator, provenance, release-report, index/comment, and survey tests.
- Full-project typecheck and required verify:fast: 111 affected test files,
  1,735 tests passed after all review corrections. Full lint and verify:pr-prereqs
  passed, as did ADR/path/handoff checks.
- Renderer tests plus actual headless Chromium rendering of the production
  viewer with runtime-produced diagnostic data; no browser script errors.
- One headless runtime smoke: seed 42, sword, experienced_player, 3,600 frames.
  Old evaluator assigned 0.43 confidence and 11.67 choice depth; v2 marks both
  unmeasured. This checks wiring only, not balance or player enjoyment.
- Independent design review selected versioned migration over cosmetic renaming
  or an uncalibrated replacement predictor (ADR 0110). Post-diff review found
  the initial-level sensor bug; corrected with real-run regression tests.
- Local Ducky review additionally identified progression carryover assertions,
  missing release-preset attribution, and the public-page migration. These were
  fixed with explicit starting-level telemetry and producer/consumer tests.
- All five headless progression tests passed, including actual floor-to-floor
  level carryover. A batching regression confirms equal earned levels receive
  equal progression credit; absent starting-level evidence remains unmeasured.
- Fresh local Ducky review of the complete diff found no actionable regressions
  after all corrections; all 78 focused unit and 13 renderer tests passed.
  Codex/Ducky review passed and the change is okay to check in. The review's
  own preflight stalled at Playwright installation; the implementation session
  separately completed typecheck, required verification, and browser checks.

## Remaining limitations

Heuristic reference values are not enjoyment thresholds. Nearby combat uptime,
meaningful decisions, build diversity, crafting payoff, and subjective power
growth still need appropriate telemetry and/or human calibration. Legacy data
has unknown coverage. Unlabelled bot policies and human sessions cannot supply
matched deterministic comparison identities. No local sweep or player study
was performed.

## Publication and ownership

### CI routing follow-up

At the user's request, dedicated telemetry/headless-reporting modules and the
standalone public release report no longer trigger game UX tests. The classifier
uses explicit paths; gameplay/scene/AI-policy edits, new unclassified source
files, and mixed diffs retain visual routing. Simulation, coverage, integration,
and security decisions are unchanged. This PR's complete scope now emits all
four visual flags as false. Focused classifier/workflow wiring: 125 tests passed.
Live run-bundle upload payloads retain browser coverage for requests and visible
completion toasts. Preflight, fast verification, and PR prerequisites passed.
Fresh Ducky review found no actionable regressions; review passed and this
follow-up is okay to check in.

Publish ready for review through the normal merge train. Release ownership after
publication; CI Recovery handles subsequent CI/review blockers.
