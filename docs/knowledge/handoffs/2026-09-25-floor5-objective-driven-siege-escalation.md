# Session Handoff: Floor 5 objective-driven siege escalation

## Date

2026-09-25

## Persona

Producer coordinating Game Designer (pressure), Systems Engineer (deterministic
spawn/lifecycle), UX Designer (cues/HUD), and QA Engineer (headless and real
scene evidence).

## Systems touched

Floor 5 siege objectives, lane waves, field Heroes, Ram escort, finale,
scenario HUD, headless objective pilot, real-scene probe.

## Planning contract

The hard gate is a deterministic Floor 5 run with immediate combat pressure,
six objective-coupled escalation beats, no idle reinforcement progress, at
most sixteen hostile minions and two field Heroes, ordinary weapon
targetability, and zero leaked lane actors/debt after breach. Ranked
tiebreakers were determinism, independent verification, then bounded runtime
cost. The human approved provisional tuning of 16 minions, 2 Heroes, and +3
minions per pre-breach objective beat.

The Producer CLI misclassified the explicit measurable gate as missing twice;
no delegation occurred. The implementation followed the validated session
contract directly. ADR 0110 records the cross-system decision.

## What changed

- Added objective-owned reinforcement state with a four-hostile opening cap,
  +3 pressure at supplies/control/Ram-build/Ram-escort, and a hard cap of 16.
- Kept objective debt separate from authored wave accounting, while reusing
  the established deterministic enemy archetype and siege lifecycle.
- Brought the first seeded field Hero forward after the first escalation beat;
  the existing single active slot remains under the approved two-Hero ceiling.
- Recorded gate breach and throne approach as visible escalation beats. Lane
  spawning stays frozen after breach; authored courtyard and throne actors own
  post-breach density.
- Added announcements and a live HUD pressure line for minions, caps, Heroes,
  and completed beats.
- Extended the real objective pilot to move into weapon range and target Ram
  threats through ordinary combat input. Objective reinforcements use lighter
  combat stats so the real weapon pipeline, not injected lethal damage, carries
  the escort.

## Observation and verification

- Ten focused Floor 5 suites passed: 64 tests covering idle behavior,
  objective coupling, Hero timing, targeting, full Ram lifecycle, finale,
  release telemetry, caps, and cleanup.
- The real MainGameScene Playwright probe passed for sword, knife, bow, pistol,
  and throwing knife. Each damaged hostile minions and the field Hero without
  friendly fire; the escalation HUD rendered within 1280×720 and 960×540.
- Visual inspection of `files/floor5-siege-escalation-evidence` confirmed
  distinct allied/hostile/Hero/Ram/structure silhouettes and a readable
  four-line siege HUD above the ability bar.
- `npm run verify:fast` passed: 77 files and 1,019 tests, followed by all
  data-contract, integrity, and coverage checks.
- The first review identified a release-gate shortcut that masked excessive
  escort damage. The shortcut was removed, reinforcements were retuned to
  lighter real combatants, and the 10-seed gate passed with its original
  thresholds. Fresh Ducky and independent complete-diff reviews then reported
  no actionable findings.

## Publication readiness

The branch rebased cleanly onto `origin/main`; the 64 focused tests and
`npm run verify:fast` passed again on the rebased HEAD. Final Ducky review found
no actionable regressions, and `npm run verify:pr-prereqs` passed. Publish a
ready-for-review PR without auto-merge.
