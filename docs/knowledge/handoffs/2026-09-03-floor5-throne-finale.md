# Session Handoff: Floor 5 courtyard, Crown Auditor, Regent Emeritus, throne capture

## Date

2026-09-03

## Persona

Producer → Systems Engineer / Game Designer / QA

## Systems touched

mapgen, quests, enemies, ai-behavior-tree, devtools

## Apples

5🍎 estimated, 5🍎 actual.

## What Was Done

Implemented Floor 5 Slice 6 for issue #3916 (spec `R7`, `FR7.1`–`FR7.5`).

- Added a manifest-backed `floor5.finale` block: Crown Auditor, authored
  courtyard defenders, Regent Emeritus, bounded Regent summons, and the throne
  capture interaction radius. All four actor kinds share one authored combatant
  schema so the encounter can be retuned in one place.
- Added zod validation that summon health-fraction triggers are strictly
  descending and that the summon cap admits every authored trigger wave.
- Added `Floor5FinaleState` / `Floor5FinaleActorState` types plus a
  `Floor5SiegeRunStats.finale` projection covering frames, health, defeat
  counts, gates, summon accounting, capture attempts, and cleanup receipts.
- Sealed the throne doors and the Winner's Balcony at floor init with the same
  dynamic poly-barrier mechanism the breach ingress already uses, so both are
  real navigation gates rather than tile-flag mutations.
- Added the breach → courtyard handoff, which reads the one-shot
  `breach.latched` seam (never a re-derived "is the wall down"), spawns the
  fixed courtyard encounter at layout-derived anchors, and records the
  `COURTYARD` phase transition.
- Added the throne-door gate: clearing the Auditor and every authored defender
  drops the barrier, records `THRONE`, and fields Regent Emeritus.
- Added bounded summon release at authored Regent health fractions; released
  summons can never exceed `summons.maxTotal`, and the surviving summons are
  retired with the encounter when the Regent falls.
- Added the **separate** capture interaction: `requestFloor5ThroneCapture`
  enforces state legality only and counts every refusal, and an accepted request
  merely latches — `floor5ObjectiveTick` commits it after the Command Post and
  breach loss checks, so a same-tick base loss still outranks a same-tick
  capture.
- Added the one-transaction capture commit: disable royal authority, clear every
  remaining hostile, open the Winner's Balcony, then latch `CAPTURED` last.
- Wired `siegeFinaleSystem` and the capture marker/confirmation copy through the
  real Floor 5 `ScenarioDefinition`, shared by the game and the headless runner.
- Extended headless floor-progress scoring with finale terms and made the runner
  request the capture each frame (the BT AI has no throne-marker navigation
  yet), which is also what proves "cannot capture early" in a real run.
- Extended the Floor 5 siege lab with a full finale readout and a
  "Request throne capture" action.

### Post-review fixes

Two independent post-diff reviews ran (5🍎 policy). Both findings were valid and
are fixed on this branch:

- Regent summons now require an **explicit authored telegraph** (`FR7.3`):
  crossing a health fraction queues and announces a wave, and the summons only
  appear `summons.telegraphFrames` later. Wave counts are reserved against the
  cap at telegraph time, and a wave still queued when the Regent falls is
  discarded rather than spawned onto a defeated boss.
- The capture request and the capture marker now respect a terminal `DEFEAT`.
  Previously the marker stayed unlocked after a post-Regent Command Post loss
  and an accepted latch could never commit, because the objective tick had
  already stopped advancing.
- Finale actors keep `Enemy` targeting but carry zero generic contact damage,
  leaving `floor5ObjectiveTick` as their sole damage authority.
- An accepted capture latch now immediately hides and locks the capture marker
  until the objective tick commits it.
- Documented that the finale leash is measured on the TARGET's offset from the
  actor's anchor, matching `steerFloor5Hero`; the previous field comment
  implied an actor-position leash, which would oscillate at the boundary.

## Real-Artifact Observation

Observed in the **real headless pipeline** (`runHeadless`, floor5, seed 505) via
`tests/headless/floor5-throne-finale.test.ts` — not in a lab.

Before (measured during the same run, while the courtyard fight is live):

- `findTilePath(courtyard → throne)` returns no path: the throne door is shut.
- `findTilePath(throne → balcony)` returns no path: the balcony is shut.
- `requestFloor5ThroneCapture` is refused, `captured === false`, and
  `rejectedCaptureAttempts` climbs.

After (same run, after both encounters resolve and the capture is confirmed):

- `findTilePath(courtyard → throne)` returns a path once `courtyardCleared`.
- `findTilePath(throne → balcony)` returns a path once captured.
- Exactly one `COURTYARD`, one `THRONE`, one `CAPTURED` phase transition and
  zero `DEFEAT`; `stats.outcome === 'victory'`; no live finale hostiles remain;
  `balconyOpenedFrame === capturedFrame`.

## Verification

- `tests/headless/floor5-throne-finale.test.ts` — new hard gate, passing.
- `tests/unit/floor5-throne-capture.test.ts` — capture legality matrix, marker
  gating, terminal-defeat refusal, init sealing, scenario wiring, passing.
- `tests/unit/floor5-manifest-schema.test.ts` — extended with finale rules,
  14 tests passing.
- `tests/game/floor1-main-scene-options.test.ts` — updated for the new Floor 5
  system slot, passing.
- `npm run typecheck` passed.
- `npm run check:test-only-exports` and `npm run lint:dead-code` passed.
- `bash scripts/agent/verify-fast.sh` passed (811 files, 11,472 tests).
- `bash scripts/agent/verify-fast.sh` run: 11,468 tests passed with the single
  scene-options expectation failure above, which this session then fixed.

## Key Decisions

- The courtyard opens off the breach **latch**, never off wall health, so the
  handoff can only happen through the sanctioned breach transaction.
- Throne door and balcony are dynamic poly barriers, matching
  `sealFloor5BreachIngress`; nothing mutates `TileMap.flags`.
- Capture reuses the floor-agnostic `ScenarioDefinition` stair seam, so
  proximity, the `E` prompt and the confirm modal are handled generically by
  `MainGameScene`; the scenario enforces state legality only, exactly like
  Floors 1/2/3/6.
- Capture only latches from the interaction; the objective tick commits it after
  every loss check, preserving the slice-5 outcome precedence.
- Finale actors carry `Enemy` (so player weapons and the BT provider can engage
  them) but not `EnemyBehavior` (so `enemyAISystem` never double-steers them);
  `siegeFinaleSystem` is the sole stance authority and is deliberately not a
  damage or latch authority.
- No `src/core` or `src/engine` changes, so the change stays inside one
  architectural layer.

## Unresolved / Next Steps

- Finale balance numbers (health, damage, cooldowns, summon cap) are authored
  placeholders and are explicitly deferred to the Floor 5 balance slice
  (`HUMAN_GATE`).
- The courtyard/throne/capture goal flags are now driven, but no quest rows are
  authored against them yet — quest copy belongs to the content slice.
- The headless runner requests the capture unconditionally because the BT AI
  cannot navigate to the throne marker; giving the BT provider real marker
  navigation would let the run capture through the same path a player uses.
