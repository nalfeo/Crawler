# Session Handoff: Floor 6 Slice 9 Release Gate

## Date

2026-09-03

## Persona

Producer

## Systems touched

ai-combat-balance, quests, mapgen, inventory, ci-policy

## Apples

5🍎 estimated; actual pending final closeout JSON.

## What Was Done

Implemented Floor 6 Slice 9 release plumbing through existing data and telemetry paths: Floor 6 is now `mvp`/`released` with a 150s win budget, report-only PR/release sweep legs, validated Floor 6 achievements, release-gate RunStats snapshots, and focused unit/headless coverage. Observed in the real headless pipeline — before local smoke tuning, Floor 6 seeds 1/3/4/5 lost to Relay destruction; after the route-following fix plus manifest-owned Relay/tower tuning, the 10-seed local smoke panel in `tests/headless/floor6-release-gate.test.ts` passes with terminal victories, terminal integrity, cleanup, route pressure, phase durations, Relay health, and hero/tower contribution assertions.

## Key Decisions Made

- Used manifest-owned Floor 6 data (`src/shared/data/floors/floor6.manifest.json`) for the release budget, Relay damage, starter tower affordability, and release-gate thresholds instead of hard-coded test shortcuts.
- Kept Floor 6 broad sweep evidence report-only in CI/deploy matrices; Floor 1 remains the blocking release leg while Floor 6 representative sweeps run on GitHub infrastructure.
- Added Floor 6 achievements with `reward: { "type": "none" }` so achievements are validated/unlockable without inventing a Floor 6 reward economy.
- Changed Floor 6 raiders to step directly along authored route waypoints with zero velocity, reducing collision/pathing soft-lock risk while preserving deterministic route telemetry.
- Froze terminal phase-duration telemetry for VICTORY/DEFEAT snapshots so RunStats remain idempotent after terminal state.

## What's Next / Blockers

- Run the remaining closeout checks: `npm run verify:pr-prereqs`, required 5🍎 post-diff reviews, automated code review, CodeQL, apple metrics, and final progress report.
- The issue asks for deferred numeric HUMAN_GATE approvals via representative GitHub-backed sweeps. This PR wires the report-only Floor 6 sweep legs and manifest thresholds, but no human approval record was invented in this session.
- CI/deploy should provide the broader Floor 6 15-seed PR and 150-seed release report-only evidence; local validation intentionally stayed at 10 smoke seeds.

## Retrospective

### Lessons Learned

Floor 6’s short local `questStallFrames: 3000` diagnostic can misclassify late but valid wins as stalls; official/default headless budgets are much larger and the release-gate test avoids that short watchdog. Adding a new implemented floor also reaches release-balance, baseline regression, deploy workflow parity, and scenario-definition tests beyond the obvious floor manifest tests.

### Mistakes Made

The first release-gate phase-duration implementation used the current frame for open terminal phases, which made terminal RunStats change after victory/defeat even though the game state was idempotent. I also initially updated only the focused sweep-leg test and missed secondary baseline/report workflow parity tests until `verify:fast` surfaced them.

### Opportunities for Future Improvement

Consider adding a small shared fixture/helper for report-only release legs so adding a floor does not require updating several separate unit-test fixtures. The Floor 6 Relay health cushion is currently measured at 1% on the local smoke panel; after GitHub-backed representative sweep evidence lands, the maintainer may want to approve a higher cushion target and tune through manifest-owned data if needed.
