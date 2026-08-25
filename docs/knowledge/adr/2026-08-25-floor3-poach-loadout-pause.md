# ADR: Floor 3 poach offer rides the shared `'loadout'` pause

## Status

Accepted

## Date

2026-08-25

## Estimated Complexity

🍎 x 3 — three UX surfaces plus one new sim-side pause producer, all on existing
UI and scenario patterns.

## Context

Floor 3 slice 12 ships the first UX group of the Companion League: the welcome /
rules briefing, the starter-Companion picker, and the poach-a-Companion picker
(game-design §15 surfaces #1–#3). The first two are floor-entry screens that the
existing `'loadout'` pause already serves. The third is different: poaching
happens **mid-run**, every time the player beats a Trainer, and it must block the
floor until the player picks — otherwise the reward silently disappears.

That crosses three layers. The pause state lives in `src/core` (`world.ts`
`FloorExtendedState`) and `src/shared` (`floor-types.ts`), the producer lives in
`src/game` (`floor3Scenario.ts`), and the two consumers are `src/engine`
(`MainGameScene`'s modal) and `src/game/ai` (`headless-runner.ts`). A
cross-system record is therefore required.

## Decision

- **Reuse the floor-agnostic `'loadout'` world state for the poach pause** rather
  than introducing a Floor-3-specific `'poach'` state. The offer is carried in
  `world.floorExtendedState.floor3PoachOffer`, and `selectFloor3LoadoutOption`
  is the single scenario dispatcher that resolves whichever offer is pending
  (poach takes priority over the floor-entry starter offer).
- **Raise the offer at the top of a fresh `'playing'` tick**, not inside the
  Studio-defeat loop, behind a per-encounter `poachOffered` latch. Terminal
  transitions (Final Four unlock, victory latch, party wipe) therefore always
  complete before the floor pauses, and two Studios wiped on the same tick
  produce two offers on consecutive ticks instead of interleaving.
- **Teach the headless runner to resolve mid-run `'loadout'` re-entry** (option
  0), mirroring `MainGameScene.update()`'s modal reopen. This is generic, not
  Floor-3-specific, so any future scenario may pause mid-run.
- **Keep the offer contract producer-agnostic.** Studio-handler defeat is its
  only current producer; roaming Trainers (a later slice) plug into
  `buildFloor3PoachOffer` unchanged.
- **Render all three surfaces from one pure shared module**
  (`src/shared/floor3-ux.ts`) that returns `ModalPickerConfig`, so the game and
  the `floor3-ux-lab` cannot drift and the copy is unit-testable without Phaser.

## Consequences

### Positive

- No new world state: every existing consumer of `world.state` keeps working,
  and Floor 1's starter-weapon pause, Floor 3's starter pick, and Floor 3's
  poach pick all share one code path in both runners.
- Both pick paths are never-strand: an out-of-range or unmatched pick clamps to
  candidate 0 and always returns the world to `'playing'`.
- The surfaces are deterministic, seeded, and covered by unit tests plus a real
  headless regression test.

### Negative

- Any test that ticks `floor3ObjectiveTick` past a Studio defeat must now drain
  the pause (see `drainPoachOffers` in `tests/unit/floor3-victory-system.test.ts`).
- The headless runner always takes option 0, so AI runs never express a poach
  _preference_; a scoring hook is future work if poach choice starts mattering
  to win rate.

### Risks

- A future scenario that pauses on `'loadout'` without clearing its offer would
  be auto-resolved every frame by the runner. Mitigated because every
  `selectLoadoutOption` implementation clears its offer and resumes `'playing'`,
  which the poach unit tests assert directly.

## Alternatives Considered

- **A dedicated `'poach'` world state.** Rejected: it would require a new branch
  in the headless runner, the scene update loop, every objective tick guard, and
  any future `world.state` consumer, for no behavioral gain.
- **Auto-recruiting the best candidate with no pause.** Rejected: the spec's
  party lock (starter + 5 poaches, §6.3) makes each poach one of the six most
  consequential player decisions on the floor.
- **Pausing inside the Studio-defeat loop.** Rejected on plan review: it can
  interleave with the Final Four unlock and victory latch, and can double-fire
  when two Studios are wiped on the same tick.
