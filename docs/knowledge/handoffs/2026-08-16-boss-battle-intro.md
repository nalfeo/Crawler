# Boss battle introduction lore sheet

**Date:** 2026-08-16
**Apples:** 3🍎 (declared 3🍎, actual 3🍎)

## Systems touched

boss-rooms, hud-ux

## Summary

Every boss encounter now opens with a paused lore sheet: the boss's real sprite
on the left, The Director's flavour text on the right, dismissed with a click or
`Space`/`Enter`/`Escape`. The simulation freezes while it is up (same pattern as
`LevelUpUI`/`RewardOpeningUI`), so the player reads the billing before taking a
hit. Each boss introduces itself exactly once per run.

Coverage is both boss sources:

- Floor 1 — `world.floorScenario.objective.bossBattles` (`slime-rat`,
  `staircase`), hand-authored copy.
- Floor 2 — `world.floorExtendedState.familyState.bossEncounters`, derived
  deterministically per family from `families.json` (name, den, hud colour), so
  new families get an intro for free.

Engine-layer only: the sim, the headless runner, and the win-rate gates are
untouched, so determinism is unaffected.

## Files touched

- `src/shared/boss-intro.ts` (new) — content catalog + resolvers.
- `src/engine/boss-intro-state.ts` (new) — pure `resolvePendingBossIntro`.
- `src/engine/BossIntroUI.ts` (new) — the lore sheet (measured layout).
- `src/engine/PhaserBridge.ts` — exported `resolveRenderKindPortraitTexture`.
- `src/engine/scenes/MainGameScene.ts` — create/shutdown, freeze branch,
  blocking-surface lists, `showBossIntroIfNeeded`, `driveAutoBossIntro`.
- `src/labs/boss-intro-lab/index.ts` (new) + `src/lab-main.ts`.
- `src/labs/main-scene-probe-lab/index.ts`, `tests/e2e/helpers/main-scene-probe.ts`
  — probe seams (`startStaircaseBossBattle`, `getBossIntroState`, `dismissBossIntro`).
- `tests/unit/boss-intro.test.ts`, `tests/unit/boss-intro-state.test.ts`,
  `tests/e2e/boss-intro-observation.test.ts`.

## Verification (observe before done, rule #9)

Observed in the **real `MainGameScene`** via `main-scene-probe-lab`, not in the
boss-intro lab:

- BEFORE: no sheet, world clock advancing (`worldElapsedMs` increasing).
- AFTER starting the real staircase encounter: the scene opened
  `floor1:staircase` from its own `update()` (the test never opens UI), and the
  world clock stayed byte-identical across 500ms of wall time — genuinely
  frozen, not merely covered.
- ON DISMISS: sheet closed, clock advanced again, and the intro never re-fired.
- Screenshot of the running scene confirmed the real Rat Slime sprite in the
  portrait frame.

The first screenshot exposed a layout bug: the fixed 520x300 sheet clipped its
last flavour paragraph through the footer. The sheet now measures its copy and
grows (stepping the flavour font down for very long entries), and that
visual-bug class is promoted to a deterministic e2e assertion — every measured
box must stay inside the panel and the flavour block must end above the footer.

- `npm run typecheck`, `npm run lint`, `npm run format`
- `tests/unit/boss-intro*.test.ts` (18 tests)
- `npx vitest run --project e2e tests/e2e/boss-intro-observation.test.ts`

## Follow-ups

- Audio sting on sheet open.
- Floor 3+ bosses fall back to a generic sheet until authored copy exists.
