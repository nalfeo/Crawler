# Handoff — Floor 3 rehabilitation PR 1: automatic companion growth

## Date

2026-09-20

## Persona

Producer coordinating UX Designer (command removal), Systems Engineer/Game
Designer (growth and combat), QA Engineer (parity and regression), and Reviewer
(independent design and final-diff review).

## Systems touched

enemies, ai-combat-balance, hud-ux, unit-tests

## What Was Done

- Removed companion command state, C binding, touch control, HUD charge pips,
  capacity/cooldowns, unlock toast, tuning, lab registration, and obsolete tests.
  Roster inspection, touch/R controls, pause behavior, and progress notices remain.
- Connected authored form growth to health, automatic damage, movement/reach,
  and the live sprite scale. Living injury fraction survives evolution; same-frame
  zero HP and KO sentinel health cannot be revived by XP.
- Added automatic rotation of learned milestone attacks with explicit damage and
  recovery profiles; no input or HUD state controls attack timing. The lab runs
  the same combat pipeline and reports actual stats and the last automatic attack.
- Initialized Floor 3 rival roster XP at its recruited level's baseline.
- Scoped new growth/profiles to Floor 3, preserving kept-companion combat on later
  floors. No Trainer or Studio ordering changes are included.
- Recorded architecture and the limit of generic attack profiles in ADR 0108.
- Repaired an existing stale build-vs-buy policy citation in ADR 0043, discovered
  by the required documentation check; no policy or check was relaxed.

## Plan and sequencing

The confirmed hard gate is passing real MainGameScene and deterministic headless
checks showing no active command mechanic and actual evolved health, damage,
speed/range, visual scale, and automatically available abilities. Ranked
tiebreakers: determinism, production evidence, bounded scope.

1. UX removes the command surface independently of combat.
2. Systems reuses species form scales in spawn/progression; combat consumes them.
3. QA verifies the dependent production seams, direct/evolved parity, KO safety,
   replay, and later-floor exclusion.
4. Complete focused checks, repository gates, local Ducky and independent review,
   then publish ready for review and release local ownership.

The executable decomposition reported READY, confidence 90%, and no DAG errors
after expressing the supplied gate in its recognized test-pass syntax. Manual
routing refined the generic decomposition: no new AI or graphics subsystem was
needed. One coordinating handoff owns all slices.

## Acceptance evidence

- Before: the unchanged real-scene party UX test demonstrated C/touch command
  charge consumption. Source inspection found progression only writing level/form
  and combat using fixed damage; existing sprite scaling never read form growth.
- After: real MainGameScene tests verify C is not registered, no command control
  or charge state exists, C while playing leaves party state unchanged, and the
  roster still pauses/resumes correctly. Live bounds prove the party HUD clears
  the remaining corner controls.
- Real scene evolution: L24 to L25 from an automatic kill changes HP 160/80 to
  240/120, speed and range by sqrt(1.5), rendered sprite size increases, and the
  adult `f3.ember-slinger.l25` ability executes automatically. Screenshots are in
  `files/floor3-growth/before.png` and `after.png`; the final party layout is in
  `files/floor3-auto-party-main-scene.png`.
- Headless: two seed-4445 production runs evolve a wounded L24 companion to adult,
  observe its automatic L25 attack, and produce identical growth values.
- Focused tests cover direct adult recruitment versus sequential evolution,
  melee/projectile damage, all five attack profiles, cooldowns, generation reuse,
  dead/KO suppression, and Floor 4 exclusion.

## Validation

- Preflight passed on pinned Node 22.23.2 after the sandbox blocked npm registry
  access and the approved network retry installed dependencies.
- Focused combat: 18 tests; growth: 7 tests; UX: 79 tests; party browser: 7 tests;
  real evolution browser: 1 test; deterministic headless evolution: 1 test — pass.
- `npm run scope` identifies simulation, integration, and visual coverage.
- `npm run verify:fast` passed: 355 files / 4,738 affected tests plus data,
  integrity, and simulation checks. Full typecheck passed after the final QA edit.
- `npm run verify:pr-prereqs` passed with pinned Node and Git Bash on PATH.
- Independent design and post-diff review found no actionable findings.
- Local Ducky review found no actionable regressions. Its redundant preflight
  interrupted dependencies, so the owning session restored the pinned lockfile
  installation and reran validation. The final Ducky refresh passed 261 tests in
  26 files and found no actionable regressions, including the reward fixture
  correction. Browser evidence was independently completed by the owning session.
- Reward-track integration passes with the original baseline and payout gates:
  the fixture rival survives setup, then real companion-attributed damage defeats
  it. Its old 8 HP allowed newly effective adult attacks to kill it during setup.
- Documentation checks and system-wiring checks pass.
- No guard telemetry file existed in this session.

## What's Next

PR 2 should begin only after PR 1 merges. Implement the separately scoped roaming
Trainer/recruitment encounter loop next, using this automatic growth/combat
contract; keep Studio order gates for their planned subsequent slice. Do not
restore commands. Species-specific ability effects and broad balance sweeps are
separate work, not acceptance claims of this PR.

After publication, CI Recovery/cloud ownership and the merge train handle remote
validation; this local implementation session releases ownership immediately.

## Retrospective

### Lessons Learned

The existing companion combat pipeline also serves kept companions on later
floors. Explicit floor guards are essential to a Floor 3-only repair.

### Mistakes Made

The first inspection used a guessed scenario directory that did not exist; the
file inventory located the actual single-file scenario. A concurrent QA edit also
reached typecheck before its projectile damage-store correction was finished.
The review subprocess also reran preflight concurrently with verification, which
removed dependencies; future reviews should inherit `PREFLIGHT_DEPS_ALREADY_READY=1`
after this session's preflight is complete.

### Opportunities for Future Improvement

Author species-specific effects behind the stable automatic ability IDs, retaining
deterministic execution and the real-scene/headless acceptance pattern.
