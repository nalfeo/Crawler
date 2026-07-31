# Session Handoff: Level-5 passive observability CI recovery

## Date

2026-07-31

## Persona

DevOps Engineer

## Systems touched

hud-ux, ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact). The recovery stayed bounded to CI diagnosis,
one real-scene e2e repair, review artifacts, and prerequisite validation.

## What Was Done

- Pulled the failing GitHub Actions logs for run `30610610568` and confirmed the
  live blockers were a Prettier failure plus one `main-game-scene-ui-exclusivity`
  e2e timeout; the merge-gate and aggregate `ci` failures were downstream of those
  two roots.
- Ran Prettier over the three flagged files so `Lightweight Checks` stops failing
  on formatting alone.
- Repaired the passive-projection e2e by restoring the real safe-room world-state
  precondition after injected skill-usage events before opening the abilities
  loadout.
- Tightened the new passive-status assertion so `ACTIVE` can no longer false-pass
  inside `INACTIVE`.
- Added the required ADR and review-ledger artifacts, then re-ran the fast and PR
  prerequisite gates.

Observed in the real `main-scene-probe-lab` e2e artifact — before: the passive
projection test left the scene in `playing`/not-safe after injected usage, so the
abilities loadout never opened, and the new `ACTIVE` assertion could have passed on
`INACTIVE`; after: the test restores `safe_room`, opens the shipped loadout, and
proves the active passive row renders with an unambiguous `• ACTIVE •` status.

## Key Decisions Made

- Kept the production saferoom gating intact and fixed only the test precondition;
  no gameplay or UI requirements were weakened to green the gate.
- Treated the substring assertion bug as a real regression risk, not just a test
  style nit, because it could fully mask the passive-status behavior the spec meant
  to prove.
- Added a focused ADR because the branch still spans shared, game, engine, and
  e2e seams for one player-visible contract.

## What's Next / Blockers

- Push this repair commit so CI reruns on the updated branch head.
- If CI still fails, inspect the fresh logs first; the previously reported blockers
  should be cleared by this recovery patch.

## Retrospective

### Lessons Learned

- Injecting runtime events in paused-scene e2e tests can silently disturb the same
  world-state preconditions the UI under test requires; always re-establish the
  player-visible opening conditions explicitly before asserting the rendered seam.

### Mistakes Made

- I initially trusted `toContain('ACTIVE')` as a status assertion; because
  `INACTIVE` contains that substring, the check could not distinguish the intended
  state at all.

### Opportunities for Future Improvement

- Expose structured passive projection fields from the probe seam so future tests
  assert semantic status directly instead of parsing detail strings.
