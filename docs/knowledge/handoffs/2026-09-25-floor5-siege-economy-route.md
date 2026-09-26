# Session Handoff: Floor 5 siege-economy Command Post route

## Date

2026-09-25

## Persona

Producer coordinating the Floor 5 gameplay/presentation and QA seams.

## Systems touched

Floor 5 siege HUD presentation, objective-payoff projection, deterministic
headless finale route, and real MainGameScene HUD observation.

## Recommendation and decision

**Recommended.** The objective-driven reinforcement ledger was already the
authoritative deterministic siege payoff, but a player could not read that
payoff at the Command Post until it dealt damage. The smallest correct change
projects the existing ledger; it adds no system, RNG, combat rule, balance
number, or alternate progression path. No ADR is required.

## What changed

- Command Post HUD now names the current objective-payoff escalation. It starts
  at `holding line`, shows the latest committed payoff and its six-beat index,
  and changes to `breach open — route to throne` when the sanctioned breach
  latch opens the finale route.
- Damage warnings retain priority and their existing audio/VFX cue identities;
  terminal capture/defeat labels remain non-danger states.
- The ordinary-input Floor 5 headless pilot now captures the HUD at the
  component payoff and breach transition, alongside the existing full
  courtyard-to-throne capture proof.
- The real MainGameScene probe asserts the new baseline escalation copy while
  retaining its normal weapon-input and HUD-layout checks.

## Observation

Before: a full-health Command Post rendered `secure` while component recovery
had already released its objective-owned hostile pressure; the breach did not
spell out the route to the throne.

After: the deterministic pilot moves and interacts through the component task,
then observes `siege payoff 1/6 — supplies applied` at `1000/1000 HP`; at the
latched breach it observes `breach open — route to throne`, and the same run
captures the throne exactly once with no defeat. The real Phaser scene renders
the baseline `Escalation: holding line` text after ordinary weapon input and
keeps the HUD inside its safe layout.

## Verification

- `npm test -- --project unit tests/unit/floor5-presentation.test.ts` — passed
  (7 tests).
- `npm test -- --project headless tests/headless/floor5-throne-finale.test.ts`
  — passed (ordinary-input full route/capture).
- `npm run typecheck:src` and focused ESLint/Prettier — passed.
- `npm test -- --project e2e-game tests/e2e/main-game-scene-floor5-combat.test.ts -t sword`
  — passed with Chromium host launch permission (1 test).
- `npm run verify:fast` — passed (76 files, 1,009 tests plus integrity gates).
- Fresh local Ducky complete-diff review — no actionable findings; okay to
  check in.

## Follow-up

Run `verify:pr-prereqs` after the pre-publish main sync, then publish one
ready-for-review PR. Do not arm auto-merge or wait for CI/review ownership.
