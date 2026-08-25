# Handoff: Floor 3 slice 12 — onboarding, starter, and poach UX surfaces

## Date

2026-08-25

## Persona

UX Designer

## Systems touched

hud-ux, quests

## Apples

3🍎 estimated, 3🍎 actual (exact).

## Summary

Implemented the first Floor 3 UX group (issue #3537 / spec slice 12): UX surfaces
#1 welcome + rules briefing, #2 starter-Companion picker, and #3 poach-a-Companion
picker, plus the sim-side state the poach surface needs.

- `src/shared/floor3-ux.ts` is a new pure, Phaser-free presentation module that
  builds a `ModalPickerConfig` for each surface. `MainGameScene` and the new
  `floor3-ux-lab` both render from it, so the game and the lab cannot drift.
- The poach offer rides the existing floor-agnostic `'loadout'` pause instead of
  a new world state. `floor3ObjectiveTick` raises one offer per defeated Studio
  at the **top of a fresh `'playing'` tick**, behind a per-encounter
  `poachOffered` latch, so terminal transitions (Final Four unlock, victory
  latch, party wipe) always complete before the floor pauses and two same-tick
  wipes yield two offers on consecutive ticks rather than interleaving.
- `selectFloor3LoadoutOption` is the single scenario dispatcher: a pending poach
  offer wins over the starter offer. Both picks are never-strand — an
  out-of-range index clamps to candidate 0 and the world always returns to
  `'playing'`.
- `headless-runner.ts` now resolves **mid-run** `'loadout'` re-entry with option
  0, mirroring `MainGameScene.update()`'s modal reopen. Without it a Floor 3
  headless run stalls permanently at the first poach.
- `MainGameScene` gained a single priority resolver: intro (once per floor
  entry) → pending poach → starter.

## Key decisions

- **Studio-handler defeat is the only current poach producer.** Roaming Trainers
  are a later slice; a Studio is run by a handler fielding 3–4 Companions
  (game-design §12.1), so the offer contract (`floor3PoachOffer`,
  `buildFloor3PoachOffer`) is deliberately generic and will accept a Trainer
  producer unchanged. This was raised in plan review and is a scoped decision,
  not an oversight.
- **Reuse `'loadout'` rather than adding a `'poach'` state**, so every existing
  consumer of `world.state` (headless runner, scene, objective ticks) keeps
  working with no new branches.
- **Per-candidate levels.** `Floor3PoachCandidate` carries `{speciesId, level}`
  and each picker row renders the form/level the player would actually recruit;
  duplicate species on one roster collapse to the highest level before seeded
  ordering.

## Verification run

- `npx vitest run tests/unit/floor3-ux-surfaces.test.ts tests/unit/floor3-ux-wiring.test.ts tests/unit/floor3-poach-offer.test.ts` — 29 pass.
- `npx vitest run --project headless tests/headless/floor3-poach-loadout.test.ts` — 1 pass.
- `npx vitest run tests/unit/floor3 tests/unit/ai-runner-lab-floor3-wiring.test.ts` — 94 pass (11 files).
- `npm run lint`, Prettier, `npx tsc --noEmit` (both projects) — clean.
- `bash scripts/agent/verify-fast.sh` — pass (144 files, 2,368 tests).
- Review ledger `docs/knowledge/review-ledgers/2026-08-25-floor3-slice12-ux.review-ledger.json`
  — valid 3🍎 ledger; plan review (`gpt-5.6-terra`) 6/6 resolved, code-review loop
  clean after 3 rounds, independent grade 5/5 with no findings.

## Real artifact observation

Rule #9 evidence comes from the **real headless pipeline**, not the lab.
`tests/headless/floor3-poach-loadout.test.ts` drives an actual `runHeadless`
Floor 3 run, wipes one spawned Studio roster, and observes what the runner does
with the pause that defeat produces:

- **Before** (mid-run loadout resolution deleted from `headless-runner.ts`): the
  run ends stuck — `AssertionError: expected 'loadout' not to be 'loadout'`. The
  floor objective tick only runs while `'playing'`, so the rest of the run is
  dead.
- **After**: the run finishes in a simulating state, `floor3PoachOffer` is
  cleared, and the party grew by exactly the poached Companion.

The three surfaces themselves are additionally viewable with the real
`ModalPickerUI` via `npm run lab` → `?lab=floor3-ux-lab`.

## Unresolved issues

- Roaming Trainers (the other producer of poach offers) and UX surfaces #4–#14
  from game-design §15 remain for later Floor 3 slices.
- Existing Floor 3 tests that tick past a Studio defeat must now drain the poach
  pause (`drainPoachOffers` in `tests/unit/floor3-victory-system.test.ts` is the
  reference pattern); future Floor 3 tests should reuse that shape.
